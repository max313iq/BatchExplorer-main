/**
 * useCommandPalette — registry hook for command-palette entries.
 *
 * The actual `<CommandMenu>` UI (Mod+K dialog) lives in pages-pod's
 * `shared/command-menu.tsx`. This module owns the cross-cutting registry
 * so unrelated subsystems — auth (logout, switch sub), tasks (cancel all),
 * settings (toggle density) — can each contribute commands without a hard
 * import dependency on the dialog.
 *
 * Architecture:
 *
 *   - A module-scoped `Map<id, RegisteredCommand>` holds the live set.
 *   - `registerCommand(cmd)` inserts (or replaces by id) and returns an
 *     `unregister` callback. Calling it from a `useEffect` cleanup is the
 *     normal usage from a component.
 *   - `useRegisteredCommands()` subscribes via `useSyncExternalStore` so
 *     the dialog re-renders only when the set changes. Each subscriber
 *     gets the same frozen snapshot — safe for direct map/filter.
 *   - `useCommandRegistration(cmd, enabled)` is the ergonomic hook —
 *     register while the component is mounted and the predicate is true.
 *
 * Commands are pure data; the dialog decides how to render them.
 */
import * as React from "react";
const registry = new Map();
const listeners = new Set();
let snapshot = [];
function rebuildSnapshot() {
    // Stable sort by priority (default 100), then label.
    const arr = Array.from(registry.values()).sort((a, b) => {
        var _a, _b;
        const pa = (_a = a.priority) !== null && _a !== void 0 ? _a : 100;
        const pb = (_b = b.priority) !== null && _b !== void 0 ? _b : 100;
        if (pa !== pb)
            return pa - pb;
        return a.label.localeCompare(b.label);
    });
    snapshot = Object.freeze(arr);
}
rebuildSnapshot();
function emit() {
    rebuildSnapshot();
    for (const fn of listeners)
        fn();
}
/**
 * Imperatively register a command. Returns an unregister function. Safe to
 * call outside React (e.g. from an auth event handler that wants to add a
 * "Sign out" entry only while logged in).
 */
export function registerCommand(cmd) {
    registry.set(cmd.id, cmd);
    emit();
    return () => {
        // Only remove if the current value is still ours — prevents a stale
        // unregister from killing a replacement command with the same id.
        if (registry.get(cmd.id) === cmd) {
            registry.delete(cmd.id);
            emit();
        }
    };
}
/**
 * React subscription to the registered-commands list. Re-renders only when
 * the set changes (frozen array reference identity).
 */
export function useRegisteredCommands() {
    return React.useSyncExternalStore((onChange) => {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
    }, () => snapshot, () => snapshot);
}
/**
 * Convenience: register a command for as long as the component is mounted
 * (and optionally only while `enabled` is true). The command's `run` is
 * captured in a ref so callers can pass a fresh closure each render
 * without re-registering.
 */
export function useCommandRegistration(command, enabled = true) {
    var _a;
    const runRef = React.useRef(command.run);
    runRef.current = command.run;
    React.useEffect(() => {
        if (!enabled)
            return;
        const wrapped = Object.assign(Object.assign({}, command), { run: () => runRef.current() });
        const unregister = registerCommand(wrapped);
        return unregister;
        // We deliberately depend on stable scalar fields so swapping the run
        // closure each render does not re-register. `keywords` is fingerprinted
        // via its join so an inline array doesn't churn.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        enabled,
        command.id,
        command.label,
        command.description,
        command.shortcut,
        command.section,
        command.priority,
        ((_a = command.keywords) !== null && _a !== void 0 ? _a : []).join("|"),
    ]);
}
/**
 * Test-only: wipe the registry. Don't call this from production code; it
 * exists so jest's `beforeEach` can reset state between tests.
 */
export function __resetCommandRegistry() {
    registry.clear();
    emit();
}
//# sourceMappingURL=use-command-palette.js.map