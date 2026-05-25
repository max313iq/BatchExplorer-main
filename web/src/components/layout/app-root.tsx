import { RootPane } from "@azure/bonito-ui/lib/components";
import { ThemeName } from "@azure/bonito-ui/lib/theme";
import * as React from "react";

export interface RootProps {
  theme?: ThemeName;
  children?: React.ReactNode;
}

/**
 * Top-level pane. Still wraps `RootPane` from bonito-ui so the
 * Fluent-themed parts of the app (Monaco editor, any forms surfaced
 * by bonito-ui) keep their `loadTheme()` wiring. Tailwind tokens drive
 * the rest of the surface via CSS variables on `<html>`.
 */
export const AppRoot: React.FC<RootProps> = (props) => {
  return (
    <RootPane theme={props.theme}>
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        {props.children}
      </div>
    </RootPane>
  );
};
