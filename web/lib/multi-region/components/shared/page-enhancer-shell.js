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
import { isEnhancerEnabled, workflowRegistry, } from "../../agents/page-enhancers/registry";
import { useMultiRegionStore, } from "../../store/store-context";
export const PageEnhancerShell = ({ pageKey, trio, orchestrator, hidePanel, children, }) => {
    const store = useMultiRegionStore();
    const [collapsed, setCollapsed] = React.useState(() => {
        try {
            return (typeof localStorage !== "undefined" &&
                localStorage.getItem(`azbm:enhancer-panel-collapsed:${pageKey}`) === "1");
        }
        catch (_a) {
            return false;
        }
    });
    // Long-lived AbortController for the page's enhancer lifetime.
    const abortRef = React.useRef(null);
    React.useEffect(() => {
        abortRef.current = new AbortController();
        return () => { var _a; return (_a = abortRef.current) === null || _a === void 0 ? void 0 : _a.abort(); };
    }, [pageKey]);
    const ctx = React.useMemo(() => {
        if (!orchestrator || !abortRef.current)
            return null;
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
        if (!(trio === null || trio === void 0 ? void 0 : trio.workflow))
            return undefined;
        workflowRegistry.set(pageKey, trio.workflow);
        return () => {
            workflowRegistry.unset(pageKey, trio.workflow.id);
        };
    }, [pageKey, trio === null || trio === void 0 ? void 0 : trio.workflow]);
    const toolsList = React.useMemo(() => {
        if (!(trio === null || trio === void 0 ? void 0 : trio.tools) || !ctx)
            return [];
        if (!isEnhancerEnabled(trio.tools.id))
            return [];
        try {
            return trio.tools.tools(ctx);
        }
        catch (err) {
            console.error(`[PageEnhancerShell] tools(${trio.tools.id}) threw`, err);
            return [];
        }
    }, [trio === null || trio === void 0 ? void 0 : trio.tools, ctx]);
    const renderPanel = () => {
        var _a;
        if (!(trio === null || trio === void 0 ? void 0 : trio.ui) || !ctx)
            return null;
        if (!isEnhancerEnabled(trio.ui.id))
            return null;
        try {
            return trio.ui.render(ctx);
        }
        catch (err) {
            console.error(`[PageEnhancerShell] render(${trio.ui.id}) threw`, err);
            return (React.createElement("div", { className: "rounded-md border border-destructive/40 bg-destructive/5 p-2 text-2xs text-destructive" },
                "UI agent crashed: ", (_a = err === null || err === void 0 ? void 0 : err.message) !== null && _a !== void 0 ? _a : "unknown"));
        }
    };
    const showPanel = !!(trio === null || trio === void 0 ? void 0 : trio.ui) && !hidePanel && !collapsed;
    return (React.createElement("div", { className: "flex w-full flex-col gap-3" },
        toolsList.length > 0 && (React.createElement("div", { role: "toolbar", "aria-label": `${pageKey} agent tools`, className: "flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-border/60 bg-surface-sunken/40 p-2" },
            React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Agent tools"),
            toolsList.map((tool) => {
                var _a, _b;
                const Icon = tool.icon;
                return (React.createElement(Button, { key: tool.key, type: "button", variant: (_a = tool.variant) !== null && _a !== void 0 ? _a : "outline", size: "xs", disabled: tool.disabled, title: (_b = tool.hint) !== null && _b !== void 0 ? _b : tool.label, onClick: () => {
                        if (!ctx)
                            return;
                        try {
                            const result = tool.run(ctx);
                            if (result instanceof Promise) {
                                result.catch((err) => {
                                    store.addNotification({
                                        type: "error",
                                        message: `${tool.label} failed: ${err instanceof Error ? err.message : String(err)}`,
                                    });
                                });
                            }
                        }
                        catch (err) {
                            store.addNotification({
                                type: "error",
                                message: `${tool.label} failed: ${err instanceof Error ? err.message : String(err)}`,
                            });
                        }
                    } },
                    Icon ? React.createElement(Icon, null) : null,
                    tool.label));
            }))),
        React.createElement("div", { className: cn("flex w-full gap-3", showPanel ? "flex-row" : "flex-col") },
            React.createElement("div", { className: "min-w-0 flex-1" }, children),
            (trio === null || trio === void 0 ? void 0 : trio.ui) && !hidePanel && (React.createElement("aside", { className: cn("shrink-0 transition-[width] duration-150", collapsed ? "w-8" : "w-72"), "aria-label": "Page enhancement panel" },
                React.createElement(Card, { className: "h-full p-2" },
                    React.createElement("div", { className: "mb-1.5 flex items-center justify-between" },
                        React.createElement("span", { className: "truncate text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, trio.ui.title),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", "aria-label": collapsed ? "Expand panel" : "Collapse panel", onClick: () => {
                                setCollapsed((c) => {
                                    const next = !c;
                                    try {
                                        if (typeof localStorage !== "undefined") {
                                            localStorage.setItem(`azbm:enhancer-panel-collapsed:${pageKey}`, next ? "1" : "0");
                                        }
                                    }
                                    catch (_a) {
                                        /* ignore */
                                    }
                                    return next;
                                });
                            } }, collapsed ? "›" : "‹")),
                    showPanel && (React.createElement("div", { className: "text-xs text-foreground" }, renderPanel()))))))));
};
//# sourceMappingURL=page-enhancer-shell.js.map