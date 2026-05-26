import * as React from "react";
const STORAGE_KEY = "batch-theme-mode";
const DARK_VARS = {
    "--bg-primary": "#1b1b1b",
    "--bg-secondary": "#1e1e1e",
    "--bg-tertiary": "#252525",
    "--text-primary": "#eeeeee",
    "--text-secondary": "#cccccc",
    "--text-muted": "#888888",
    "--accent": "#0078d4",
    "--accent-hover": "#106ebe",
    "--danger": "#d13438",
    "--success": "#107c10",
    "--warning": "#ffb900",
    "--border": "#3b3b3b",
    "--border-subtle": "#2b2b2b",
};
const LIGHT_VARS = {
    "--bg-primary": "#ffffff",
    "--bg-secondary": "#f5f5f5",
    "--bg-tertiary": "#e8e8e8",
    "--text-primary": "#1a1a1a",
    "--text-secondary": "#333333",
    "--text-muted": "#666666",
    "--accent": "#0078d4",
    "--accent-hover": "#106ebe",
    "--danger": "#d13438",
    "--success": "#107c10",
    "--warning": "#ffb900",
    "--border": "#d2d0ce",
    "--border-subtle": "#e1dfdd",
};
function getSystemPreference() {
    if (typeof window !== "undefined" &&
        window.matchMedia("(prefers-color-scheme: light)").matches) {
        return "light";
    }
    return "dark";
}
function resolveTheme(mode) {
    if (mode === "system") {
        return getSystemPreference();
    }
    return mode;
}
function applyVars(resolved) {
    const root = document.documentElement;
    // Legacy vars: kept for any code that still references --bg-primary etc.
    const vars = resolved === "dark" ? DARK_VARS : LIGHT_VARS;
    for (const [key, value] of Object.entries(vars)) {
        root.style.setProperty(key, value);
    }
    // Modern: toggle a class so Tailwind's `darkMode: ["class"]` picks up
    // the right token set declared in styles/tailwind.css.
    if (resolved === "light") {
        root.classList.add("light");
        root.classList.remove("dark");
    }
    else {
        root.classList.add("dark");
        root.classList.remove("light");
    }
}
function readStoredMode() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === "dark" || stored === "light" || stored === "system") {
            return stored;
        }
    }
    catch (_a) {
        // localStorage may not be available
    }
    return "dark";
}
function persistMode(mode) {
    try {
        localStorage.setItem(STORAGE_KEY, mode);
    }
    catch (_a) {
        // Ignore storage errors
    }
}
const defaultContextValue = {
    mode: "dark",
    resolved: "dark",
    setMode: () => { },
    toggle: () => { },
};
const ThemeContext = React.createContext(defaultContextValue);
export const useTheme = () => React.useContext(ThemeContext);
export const ThemeProvider = ({ children, }) => {
    const [mode, setModeState] = React.useState(readStoredMode);
    const [resolved, setResolved] = React.useState(() => resolveTheme(readStoredMode()));
    const setMode = React.useCallback((newMode) => {
        setModeState(newMode);
        persistMode(newMode);
        const r = resolveTheme(newMode);
        setResolved(r);
        applyVars(r);
    }, []);
    const toggle = React.useCallback(() => {
        setModeState((prev) => {
            const next = resolveTheme(prev) === "dark" ? "light" : "dark";
            persistMode(next);
            setResolved(next);
            applyVars(next);
            return next;
        });
    }, []);
    // Apply CSS vars on mount
    React.useEffect(() => {
        applyVars(resolved);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    // Listen for system preference changes when mode is "system"
    React.useEffect(() => {
        if (mode !== "system")
            return;
        const mq = window.matchMedia("(prefers-color-scheme: light)");
        const handler = () => {
            const r = resolveTheme("system");
            setResolved(r);
            applyVars(r);
        };
        mq.addEventListener("change", handler);
        return () => mq.removeEventListener("change", handler);
    }, [mode]);
    const value = React.useMemo(() => ({ mode, resolved, setMode, toggle }), [mode, resolved, setMode, toggle]);
    return (React.createElement(ThemeContext.Provider, { value: value }, children));
};
//# sourceMappingURL=theme-provider.js.map