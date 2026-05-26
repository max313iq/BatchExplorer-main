/**
 * Command palette (Cmd-K) per Design Contract §N. Wired to the canonical
 * routes from §4.1 plus app-level actions (refresh all, save session, export
 * session, toggle theme). Pages can register their own commands via
 * `useCommands()` hook (see PageCommandsContext below).
 */
import * as React from "react";
import { type LucideIcon } from "lucide-react";
export interface AppCommand {
    /** Stable id for de-dup across page registrations. */
    id: string;
    /** Group heading (e.g. "Navigate", "Actions"). */
    group: string;
    /** User-facing label. */
    label: string;
    /** Optional searchable keywords. */
    keywords?: string[];
    /** Optional inline icon. */
    icon?: LucideIcon;
    /** Optional shortcut display (right-aligned). Display only, not a binding. */
    shortcut?: string;
    /** Action invoked on select. Called after the dialog closes. */
    run: () => void;
}
/**
 * Provider — sits inside the dashboard shell so page-level command
 * contributions can flow up to the palette. Pages call `useCommands` to
 * register their own commands; registrations are removed on unmount.
 */
export declare const PageCommandsProvider: React.FC<React.PropsWithChildren>;
/**
 * Page hook for contributing commands. Call once per page render with the
 * fresh array; the provider de-dupes by `id`.
 */
export declare function useCommands(commands: AppCommand[]): void;
interface DefaultCommandHandlers {
    onRefreshAll?: () => void;
    onSaveSession?: () => void;
    onExportSession?: () => void;
    onToggleTheme?: () => void;
    onToggleDensity?: () => void;
    onShowKeyboardHelp?: () => void;
    onSignOut?: () => void;
    onClearSignInCache?: () => void;
}
export interface CommandMenuProps extends DefaultCommandHandlers {
    /** Open-state, controlled. */
    open: boolean;
    onOpenChange: (open: boolean) => void;
}
export declare const CommandMenu: React.FC<CommandMenuProps>;
/**
 * Convenience: bind Cmd-K and own the open-state. Drop into the dashboard
 * shell once.
 */
export declare const ConnectedCommandMenu: React.FC<DefaultCommandHandlers>;
export {};
//# sourceMappingURL=command-menu.d.ts.map