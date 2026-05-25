/**
 * Wrapper that mounts a page's enhancement-agent trio:
 *   - UIAgent       → side-panel
 *   - ToolsAgent    → toolbar slot above the page
 *   - WorkflowAgent → registered globally; pages can call
 *                     workflowRegistry.intercept(pageKey, req, next)
 *
 * The original page UI is rendered unchanged via {children}. Each trio is
 * opt-in per page; missing entries are skipped gracefully.
 *
 * Per-agent enable toggles are persisted in localStorage under
 *   `azbm:agent-enabled:<agentId>` (default true). The /agents dashboard
 * lets the user disable individual agents; this hook honors that flag on
 * every render.
 */
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import {
  isEnhancerEnabled,
  workflowRegistry,
} from "../../agents/page-enhancers/registry";
import type {
  PageEnhancerContext,
  PageEnhancerTrio,
} from "../../agents/page-enhancers/types";
import {
  useMultiRegionStore,
} from "../../store/store-context";
import { type PageKey } from "./sidebar-nav";

export interface PageEnhancerShellProps {
  pageKey: PageKey;
  trio?: PageEnhancerTrio | null;
  orchestrator?: OrchestratorAgent;
  /** When true, hide the right-side panel (mobile / narrow). Default false. */
  hidePanel?: boolean;
  children: React.ReactNode;
}

export const PageEnhancerShell: React.FC<PageEnhancerShellProps> = ({
  pageKey,
  trio,
  orchestrator,
  hidePanel,
  children,
}) => {
  const store = useMultiRegionStore();
  const [collapsed, setCollapsed] = React.useState<boolean>(() => {
    try {
      return (
        typeof localStorage !== "undefined" &&
        localStorage.getItem(`azbm:enhancer-panel-collapsed:${pageKey}`) === "1"
      );
    } catch {
      return false;
    }
  });

  // Long-lived AbortController for the page's enhancer lifetime.
  const abortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    abortRef.current = new AbortController();
    return () => abortRef.current?.abort();
  }, [pageKey]);

  const ctx: PageEnhancerContext | null = React.useMemo(() => {
    if (!orchestrator || !abortRef.current) return null;
    return {
      pageKey,
      store,
      orchestrator,
      signal: abortRef.current.signal,
    };
  }, [pageKey, store, orchestrator]);

  // Register / un-register the workflow agent globally so non-page code
  // (e.g. the orchestrator) can route through it.
  React.useEffect(() => {
    if (!trio?.workflow) return undefined;
    workflowRegistry.set(pageKey, trio.workflow);
    return () => {
      workflowRegistry.unset(pageKey, trio.workflow.id);
    };
  }, [pageKey, trio?.workflow]);

  const toolsList = React.useMemo(() => {
    if (!trio?.tools || !ctx) return [];
    if (!isEnhancerEnabled(trio.tools.id)) return [];
    try {
      return trio.tools.tools(ctx);
    } catch (err) {
      console.error(
        `[PageEnhancerShell] tools(${trio.tools.id}) threw`,
        err,
      );
      return [];
    }
  }, [trio?.tools, ctx]);

  const renderPanel = (): React.ReactNode => {
    if (!trio?.ui || !ctx) return null;
    if (!isEnhancerEnabled(trio.ui.id)) return null;
    try {
      return trio.ui.render(ctx);
    } catch (err) {
      console.error(`[PageEnhancerShell] render(${trio.ui.id}) threw`, err);
      return (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-2xs text-destructive">
          UI agent crashed: {(err as Error)?.message ?? "unknown"}
        </div>
      );
    }
  };

  const showPanel = !!trio?.ui && !hidePanel && !collapsed;

  return (
    <div className="flex w-full flex-col gap-3">
      {toolsList.length > 0 && (
        <div
          role="toolbar"
          aria-label={`${pageKey} agent tools`}
          className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-border/60 bg-surface-sunken/40 p-2"
        >
          <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Agent tools
          </span>
          {toolsList.map((tool) => {
            const Icon = tool.icon;
            return (
              <Button
                key={tool.key}
                type="button"
                variant={tool.variant ?? "outline"}
                size="xs"
                disabled={tool.disabled}
                title={tool.hint ?? tool.label}
                onClick={() => {
                  if (!ctx) return;
                  try {
                    const result = tool.run(ctx);
                    if (result instanceof Promise) {
                      result.catch((err: unknown) => {
                        store.addNotification({
                          type: "error",
                          message: `${tool.label} failed: ${
                            err instanceof Error ? err.message : String(err)
                          }`,
                        });
                      });
                    }
                  } catch (err) {
                    store.addNotification({
                      type: "error",
                      message: `${tool.label} failed: ${
                        err instanceof Error ? err.message : String(err)
                      }`,
                    });
                  }
                }}
              >
                {Icon ? <Icon /> : null}
                {tool.label}
              </Button>
            );
          })}
        </div>
      )}

      <div
        className={cn(
          "flex w-full gap-3",
          showPanel ? "flex-row" : "flex-col",
        )}
      >
        <div className="min-w-0 flex-1">{children}</div>
        {trio?.ui && !hidePanel && (
          <aside
            className={cn(
              "shrink-0 transition-[width] duration-150",
              collapsed ? "w-8" : "w-72",
            )}
            aria-label="Page enhancement panel"
          >
            <Card className="h-full p-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="truncate text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {trio.ui.title}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={collapsed ? "Expand panel" : "Collapse panel"}
                  onClick={() => {
                    setCollapsed((c) => {
                      const next = !c;
                      try {
                        if (typeof localStorage !== "undefined") {
                          localStorage.setItem(
                            `azbm:enhancer-panel-collapsed:${pageKey}`,
                            next ? "1" : "0",
                          );
                        }
                      } catch {
                        /* ignore */
                      }
                      return next;
                    });
                  }}
                >
                  {collapsed ? "›" : "‹"}
                </Button>
              </div>
              {showPanel && (
                <div className="text-xs text-foreground">{renderPanel()}</div>
              )}
            </Card>
          </aside>
        )}
      </div>
    </div>
  );
};
