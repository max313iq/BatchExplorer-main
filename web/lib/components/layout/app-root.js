import { RootPane } from "@azure/bonito-ui/lib/components";
import * as React from "react";
/**
 * Top-level pane. Still wraps `RootPane` from bonito-ui so the
 * Fluent-themed parts of the app (Monaco editor, any forms surfaced
 * by bonito-ui) keep their `loadTheme()` wiring. Tailwind tokens drive
 * the rest of the surface via CSS variables on `<html>`.
 */
const RootPaneAny = RootPane;
export const AppRoot = (props) => {
    return (React.createElement(RootPaneAny, { theme: props.theme },
        React.createElement("div", { className: "flex min-h-screen flex-col bg-background text-foreground" }, props.children)));
};
//# sourceMappingURL=app-root.js.map