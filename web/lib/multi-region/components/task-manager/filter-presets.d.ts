/**
 * Saved filter presets for the Task Manager.
 *
 * Operator pain point: the toolbar combines a free-text search box, a
 * multi-select status chip set, a "Failed 24h" toggle, and a tail-mode
 * toggle. A frequent user has a handful of go-to combinations (e.g.
 * "running + my-subscription-id", "interrupted only", "failed in last
 * 24h"). Re-typing them every session is friction. This component lets
 * the operator name a current filter state and recall it with one click.
 *
 * Persistence: usePersistedState (versioned envelope), so presets survive
 * reloads. Cross-tab sync is OFF by default — presets are personal-pace,
 * and surprising the user with another tab's mutation would be annoying.
 *
 * Why a separate file:
 *   - Keeps the page-component below the readability ceiling.
 *   - Independently testable.
 *   - Co-located with task-manager per the per-page-only edit scope.
 *
 * Source-only: no new deps, no shared-component edits. Built on the
 * existing usePersistedState hook.
 */
import * as React from "react";
/** Persisted shape of a single named preset. */
export interface FilterPreset {
    /** Stable id (UUID-ish). Used as React key + delete target. */
    id: string;
    /** User-facing label. */
    name: string;
    /** Search-box query, can be empty. */
    search: string;
    /** Status chip set serialized to an array of strings (e.g. ["running", "failed"]). */
    chips: string[];
    /** "Failed in last 24h" toggle. */
    failed24h: boolean;
    /** ISO timestamp the preset was created, used for sort + display. */
    createdAt: string;
}
interface FilterPresetsProps {
    /** Current filter state — used for "Save current as preset". */
    current: {
        search: string;
        chips: Set<string>;
        failed24h: boolean;
    };
    /** Apply a preset: parent wires this up to its own setSearch / setChips / setFailed24h. */
    onApply: (preset: FilterPreset) => void;
}
export declare const FilterPresets: React.FC<FilterPresetsProps>;
export {};
//# sourceMappingURL=filter-presets.d.ts.map