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
export interface DensityToggleProps {
}
export declare const DensityToggle: React.FC<DensityToggleProps>;
//# sourceMappingURL=density-toggle.d.ts.map