/** Application root. Wires routing and the dashboard chrome. The outer
 * "Azure Batch Manager" banner + Bonito theme picker were removed —
 * the inner dashboard has its own header (search, sign-in, density,
 * dark/light) which is the only chrome the user ever needs. The Bonito
 * theme stays at `defaultTheme` since no UI surfaces a switcher anymore.
 *
 * The whole tree is wrapped in a root `ErrorBoundary` so a render-time
 * crash in the shell (or anywhere not already covered by a per-page
 * boundary) shows a reload affordance instead of a blank screen.
 */
import { defaultTheme } from "@azure/bonito-ui";
import * as React from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MultiRegionDashboard } from "../multi-region";
import { ErrorBoundary } from "../multi-region/components/shared/error-boundary";
import { AppRoot } from "./layout/app-root";
import { Footer } from "./layout/footer";
import { Main } from "./layout/main";
/**
 * Minimal fallback for the root boundary. Per-page boundaries handle the
 * usual surface-level crashes; this only fires when something fails in the
 * shell itself (theme load, routing, providers). We keep it dependency-free
 * so it works even if shadcn primitives are the thing that broke.
 */
const RootErrorFallback = () => (React.createElement("div", { role: "alert", style: {
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: "1rem",
        padding: "2rem",
        fontFamily: "Segoe UI, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        color: "#1f2937",
        background: "#f9fafb",
    } },
    React.createElement("h1", { style: { margin: 0, fontSize: "1.25rem", fontWeight: 600 } }, "App failed to load."),
    React.createElement("p", { style: { margin: 0, color: "#6b7280" } }, "Reload the page to try again. If the problem persists, clear your browser cache for this site."),
    React.createElement("button", { type: "button", onClick: () => {
            if (typeof window !== "undefined")
                window.location.reload();
        }, style: {
            padding: "0.5rem 1rem",
            border: "1px solid #2563eb",
            background: "#2563eb",
            color: "white",
            borderRadius: 6,
            cursor: "pointer",
            fontWeight: 500,
        } }, "Reload")));
export const Application = () => {
    return (React.createElement(AppRoot, { theme: defaultTheme },
        React.createElement(ErrorBoundary, { fallback: React.createElement(RootErrorFallback, null) },
            React.createElement(TooltipProvider, { delayDuration: 300, skipDelayDuration: 0 },
                React.createElement(HashRouter, null,
                    React.createElement(Main, null,
                        React.createElement(Routes, null,
                            React.createElement(Route, { path: "/*", element: React.createElement(MultiRegionDashboard, null) }))),
                    React.createElement(Footer, null))))));
};
//# sourceMappingURL=application.js.map