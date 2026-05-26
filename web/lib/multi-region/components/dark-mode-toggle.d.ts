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
export declare const DarkModeToggle: React.FC;
//# sourceMappingURL=dark-mode-toggle.d.ts.map