export interface RegisteredCommand {
    /** Stable id — used as the dedupe key and for telemetry. */
    id: string;
    /** Short label shown as the command's primary text. */
    label: string;
    /** Optional secondary text (e.g. "in Account Info"). */
    description?: string;
    /** Optional keyboard hint, e.g. "Mod+Shift+L". */
    shortcut?: string;
    /** Optional fuzzy-search keywords beyond `label`/`description`. */
    keywords?: string[];
    /** Optional logical grouping label (e.g. "Auth", "Pages"). */
    section?: string;
    /** Invoked when the user picks the command. */
    run: () => void;
    /** Optional sort priority — lower numbers float to the top. */
    priority?: number;
}
/**
 * Imperatively register a command. Returns an unregister function. Safe to
 * call outside React (e.g. from an auth event handler that wants to add a
 * "Sign out" entry only while logged in).
 */
export declare function registerCommand(cmd: RegisteredCommand): () => void;
/**
 * React subscription to the registered-commands list. Re-renders only when
 * the set changes (frozen array reference identity).
 */
export declare function useRegisteredCommands(): ReadonlyArray<RegisteredCommand>;
/**
 * Convenience: register a command for as long as the component is mounted
 * (and optionally only while `enabled` is true). The command's `run` is
 * captured in a ref so callers can pass a fresh closure each render
 * without re-registering.
 */
export declare function useCommandRegistration(command: RegisteredCommand, enabled?: boolean): void;
/**
 * Test-only: wipe the registry. Don't call this from production code; it
 * exists so jest's `beforeEach` can reset state between tests.
 */
export declare function __resetCommandRegistry(): void;
//# sourceMappingURL=use-command-palette.d.ts.map