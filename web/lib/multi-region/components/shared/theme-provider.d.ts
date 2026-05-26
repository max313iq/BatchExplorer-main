import * as React from "react";
export type ThemeMode = "dark" | "light" | "system";
export interface ThemeContextValue {
    mode: ThemeMode;
    resolved: "dark" | "light";
    setMode: (mode: ThemeMode) => void;
    toggle: () => void;
}
export declare const useTheme: () => ThemeContextValue;
export declare const ThemeProvider: React.FC<{
    children: React.ReactNode;
}>;
//# sourceMappingURL=theme-provider.d.ts.map