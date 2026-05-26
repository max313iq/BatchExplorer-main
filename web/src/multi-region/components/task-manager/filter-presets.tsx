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
import {
  Bookmark,
  BookmarkPlus,
  Check,
  Pencil,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { usePersistedState } from "../../hooks/use-persisted-state";

const STORAGE_KEY = "mr.task-manager.filter-presets";

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

/**
 * Generate a stable id without pulling in a UUID dependency. The fallback
 * is fine for purely client-side scope (preset ids never leave the browser).
 */
function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `fp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Heuristic-compare a preset against the current state to figure out which
 * preset (if any) the user is currently "on". Used to highlight the active
 * preset chip so the operator gets visible state confirmation.
 */
function matchesCurrent(
  p: FilterPreset,
  current: { search: string; chips: Set<string>; failed24h: boolean },
): boolean {
  if (p.search.trim() !== current.search.trim()) return false;
  if (p.failed24h !== current.failed24h) return false;
  if (p.chips.length !== current.chips.size) return false;
  for (const c of p.chips) {
    if (!current.chips.has(c)) return false;
  }
  return true;
}

export const FilterPresets: React.FC<FilterPresetsProps> = ({
  current,
  onApply,
}) => {
  const [presets, setPresets] = usePersistedState<FilterPreset[]>(
    STORAGE_KEY,
    [],
    { version: 1 },
  );
  const [savingName, setSavingName] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");

  const activePresetId = React.useMemo(() => {
    for (const p of presets) {
      if (matchesCurrent(p, current)) return p.id;
    }
    return null;
  }, [presets, current]);

  /**
   * Snapshot the current filter into a new preset. If a preset with the
   * same exact filter already exists, we no-op rather than create a
   * duplicate — the operator probably hit the save button twice.
   */
  const saveCurrentAs = React.useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      // De-dupe by name (case-insensitive) AND by exact filter shape.
      const lowerName = trimmed.toLowerCase();
      const dup = presets.find(
        (p) =>
          p.name.toLowerCase() === lowerName || matchesCurrent(p, current),
      );
      if (dup) return;
      const next: FilterPreset = {
        id: makeId(),
        name: trimmed,
        search: current.search,
        chips: Array.from(current.chips).sort(),
        failed24h: current.failed24h,
        createdAt: new Date().toISOString(),
      };
      setPresets((prev) => [...prev, next]);
    },
    [presets, current, setPresets],
  );

  const remove = React.useCallback(
    (id: string) => {
      setPresets((prev) => prev.filter((p) => p.id !== id));
      if (editingId === id) setEditingId(null);
    },
    [setPresets, editingId],
  );

  const rename = React.useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setPresets((prev) =>
        prev.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
      );
      setEditingId(null);
    },
    [setPresets],
  );

  // Visual: nothing to render but the Save button when there are no presets
  // and the operator hasn't started a save yet — avoids a hollow empty row.
  const hasAny = presets.length > 0;
  const inSaveMode = savingName !== null;

  // Pre-compute whether the current state is worth saving. If it's the
  // identity filter (no search, no chips, no failed24h), saving creates
  // a useless preset — gate the button.
  const currentIsEmpty =
    current.search.trim() === "" &&
    current.chips.size === 0 &&
    !current.failed24h;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5",
        !hasAny && !inSaveMode && "min-h-[24px]",
      )}
      aria-label="Saved filter presets"
    >
      {hasAny && (
        <>
          <Bookmark className="h-3 w-3 text-muted-foreground/60" aria-hidden="true" />
          {presets.map((p) =>
            editingId === p.id ? (
              <form
                key={p.id}
                onSubmit={(e) => {
                  e.preventDefault();
                  rename(p.id, editName);
                }}
                className="flex items-center gap-1"
              >
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="h-6 w-32 text-2xs"
                  autoFocus
                  aria-label="Rename preset"
                  onBlur={() => setEditingId(null)}
                />
                <button
                  type="submit"
                  className="rounded-full p-0.5 text-success hover:bg-success/10"
                  aria-label="Save rename"
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-muted/40"
                  aria-label="Cancel rename"
                >
                  <X className="h-3 w-3" />
                </button>
              </form>
            ) : (
              <PresetChip
                key={p.id}
                preset={p}
                active={p.id === activePresetId}
                onApply={onApply}
                onEdit={() => {
                  setEditingId(p.id);
                  setEditName(p.name);
                }}
                onRemove={() => remove(p.id)}
              />
            ),
          )}
        </>
      )}

      {inSaveMode ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (savingName) saveCurrentAs(savingName);
            setSavingName(null);
          }}
          className="flex items-center gap-1"
        >
          <Input
            value={savingName ?? ""}
            onChange={(e) => setSavingName(e.target.value)}
            placeholder="Preset name"
            className="h-6 w-32 text-2xs"
            autoFocus
            aria-label="Preset name"
          />
          <button
            type="submit"
            className="rounded-full p-0.5 text-success hover:bg-success/10"
            aria-label="Save preset"
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => setSavingName(null)}
            className="rounded-full p-0.5 text-muted-foreground hover:bg-muted/40"
            aria-label="Cancel save"
          >
            <X className="h-3 w-3" />
          </button>
        </form>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setSavingName("")}
              disabled={currentIsEmpty}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-2xs font-medium transition-colors duration-fast",
                currentIsEmpty
                  ? "cursor-not-allowed border-border/50 text-muted-foreground/40"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary",
              )}
              aria-label="Save current filter as preset"
            >
              <BookmarkPlus className="h-3 w-3" />
              Save preset
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {currentIsEmpty
              ? "Set up a filter first (search, chips, or Failed 24h), then save."
              : "Save the current search + chips + Failed-24h state as a named preset for one-click recall."}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};

/** Individual preset pill — apply on click, rename / remove via icon buttons. */
const PresetChip: React.FC<{
  preset: FilterPreset;
  active: boolean;
  onApply: (p: FilterPreset) => void;
  onEdit: () => void;
  onRemove: () => void;
}> = ({ preset, active, onApply, onEdit, onRemove }) => {
  return (
    <span
      className={cn(
        "group inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors duration-fast",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border bg-card text-muted-foreground hover:bg-muted/40",
      )}
    >
      <button
        type="button"
        onClick={() => onApply(preset)}
        className="flex items-center gap-1 truncate"
        aria-label={`Apply preset ${preset.name}`}
        aria-pressed={active}
      >
        <Bookmark className="h-3 w-3" aria-hidden="true" />
        <span className="max-w-[8rem] truncate">{preset.name}</span>
      </button>
      <span
        className={cn(
          "ml-0.5 hidden items-center gap-0.5 group-hover:inline-flex",
          active && "inline-flex",
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="rounded p-0.5 hover:bg-muted/40"
              aria-label={`Rename preset ${preset.name}`}
            >
              <Pencil className="h-2.5 w-2.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Rename</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              className="rounded p-0.5 hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Remove preset ${preset.name}`}
            >
              <Trash2 className="h-2.5 w-2.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Remove</TooltipContent>
        </Tooltip>
      </span>
    </span>
  );
};
