/**
 * DarkModeToggle — icon button that flips the app between dark and light
 * themes by toggling the `dark`/`light` class on `<html>`.
 * Persistence is delegated to `usePersistedState` (Contract §10).
 *
 * SOURCE OF TRUTH: the active theme is stored under the raw localStorage
 * key `batch-theme-mode` via `usePersistedState`, NOT in
 * `store.userPreferences.theme`. The store does not currently track
 * theme — by design — because:
 *   1. The theme must apply BEFORE first paint (otherwise the page flashes
 *      the wrong palette during hydration). `usePersistedState` is
 *      synchronous against localStorage; the store provider is async.
 *   2. Theme is a UA preference that should not be exported / imported as
 *      part of a session JSON file (an operator restoring a colleague's
 *      session shouldn't have their colour scheme overwritten).
 *
 * If a future change moves theme into the store, migrate the
 * `batch-theme-mode` key once and document the schema bump.
 */
import * as React from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { useBroadcastPref } from "../hooks/use-broadcast-pref";
import type { ThemeMode } from "../store/store-types";

export const DarkModeToggle: React.FC = () => {
  // useBroadcastPref persists locally AND broadcasts via BroadcastChannel
  // so flipping the theme in one window updates every other open tab in
  // real time. Removes the "open four tabs, get four colour schemes" bug
  // when an operator briefly opens a duplicate tab to copy-paste a token.
  const [theme, setTheme] = useBroadcastPref<ThemeMode>(
    "batch-theme-mode",
    "dark",
  );

  const isDark = theme === "dark";

  // Sync the resolved theme onto the html element so every page (including
  // popovers, dialogs, monaco) flips together.
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (isDark) {
      root.classList.add("dark");
      root.classList.remove("light");
    } else {
      root.classList.add("light");
      root.classList.remove("dark");
    }
  }, [isDark]);

  const label = isDark ? "Switch to light mode" : "Switch to dark mode";

  const handleToggle = (): void => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={isDark}
          onClick={handleToggle}
          className={cn(isDark ? "text-warning" : "text-primary")}
        >
          {isDark ? <Moon /> : <Sun />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
};
