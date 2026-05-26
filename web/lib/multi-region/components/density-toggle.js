/**
 * DensityToggle — header control that flips the dashboard between
 * comfortable and compact row densities. Persists the choice via
 * `usePersistedState` and applies a `density-*` class to <html> per
 * Design Contract §2.7. Self-contained: no props.
 *
 * SOURCE OF TRUTH: this toggle deliberately uses `usePersistedState` with
 * a raw localStorage key — NOT `store.userPreferences.density`. The store
 * tracks server-syncable user preferences (auto-refresh, sidebar-collapsed)
 * but density is a purely local visual preference that should not roundtrip
 * through a persisted session export. Two reasons we keep the duplication:
 *   1. The toggle ships in `multi-region/components/` and the store layer
 *      may be initialized AFTER this component renders (during hydration);
 *      `usePersistedState` is synchronous and reads localStorage directly,
 *      so the user's last choice applies before first paint.
 *   2. Density is per-tab — if the operator opens a second window the
 *      tab-broadcast hook (see #23) will eventually sync them, but until
 *      that ships it's better to leave each tab independent than to force
 *      a global override.
 *
 * If a future redesign decides density SHOULD live in `store.userPreferences`,
 * remove the `usePersistedState` call here, switch the body to
 * `useMultiRegionStore().getUserPreferences().density`, and migrate the
 * localStorage value once at first load.
 */
import * as React from "react";
import { Rows2, Rows3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { useBroadcastPref } from "../hooks/use-broadcast-pref";
const DENSITY_STORAGE_KEY = "batch-density-mode";
function applyDensity(mode) {
    if (typeof document === "undefined")
        return;
    const root = document.documentElement;
    root.classList.remove("density-compact", "density-comfortable");
    root.classList.add(`density-${mode}`);
}
export const DensityToggle = () => {
    // useBroadcastPref persists to localStorage AND emits a BroadcastChannel
    // message — so flipping the toggle in one tab updates every other open
    // tab live, without a reload. Falls back to the bare `storage` event in
    // contexts that lack BroadcastChannel (old Safari, sandboxed frames).
    const [density, setDensity] = useBroadcastPref(DENSITY_STORAGE_KEY, "comfortable");
    React.useEffect(() => {
        applyDensity(density);
    }, [density]);
    const next = density === "compact" ? "comfortable" : "compact";
    const label = `Switch to ${next} density`;
    return (React.createElement(Tooltip, null,
        React.createElement(TooltipTrigger, { asChild: true },
            React.createElement(Button, { variant: "ghost", size: "icon-sm", "aria-label": label, "aria-pressed": density === "compact", onClick: () => setDensity(next), className: "text-muted-foreground hover:text-foreground" }, density === "compact" ? (React.createElement(Rows3, { className: "h-3.5 w-3.5" })) : (React.createElement(Rows2, { className: "h-3.5 w-3.5" })))),
        React.createElement(TooltipContent, null, label)));
};
//# sourceMappingURL=density-toggle.js.map