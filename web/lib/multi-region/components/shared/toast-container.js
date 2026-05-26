import * as React from "react";
import { CheckCircle2, Info, TriangleAlert, XCircle, X } from "lucide-react";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { cn } from "@/lib/utils";
import { DEFAULT_CONFIG } from "./constants";
/**
 * Programmatic toast helper that can be called from anywhere with a store reference.
 *
 * @param store - The MultiRegionStore instance.
 * @param message - Text to display in the toast.
 * @param type - Toast severity: "success", "error", "warning", or "info" (default: "info").
 * @param durationMs - Optional auto-dismiss duration in ms. Uses default if omitted.
 */
export function showToast(store, message, type = "info", durationMs) {
    store.addNotification({
        type,
        message,
        autoDismissMs: durationMs,
    });
}
const DEFAULT_DISMISS = {
    success: 5000,
    info: 5000,
    warning: 8000,
    error: 10000,
};
const TYPE_CLASS = {
    success: "border-success/40 bg-success/15 text-success dark:bg-success/20",
    error: "border-destructive/40 bg-destructive/15 text-destructive dark:bg-destructive/20",
    warning: "border-warning/40 bg-warning/15 text-warning dark:bg-warning/20",
    info: "border-info/40 bg-info/15 text-info dark:bg-info/20",
};
const TYPE_ICON = {
    success: CheckCircle2,
    error: XCircle,
    warning: TriangleAlert,
    info: Info,
};
export const ToastContainer = () => {
    var _a;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    // Track which notifications already have an in-flight dismiss timer so a
    // new toast (or a manual dismissal of another toast) doesn't reset the
    // pending timers for every other notification — that previous behaviour
    // meant a rapid burst of toasts could keep older toasts visible
    // indefinitely as each new arrival cleared and re-started their timers.
    const timersRef = React.useRef(new Map());
    React.useEffect(() => {
        var _a;
        const ids = new Set(state.notifications.map((n) => n.id));
        // Clear any timers whose notifications are gone (manually dismissed).
        for (const [id, t] of timersRef.current) {
            if (!ids.has(id)) {
                clearTimeout(t);
                timersRef.current.delete(id);
            }
        }
        // Schedule timers for new arrivals only.
        for (const n of state.notifications) {
            if (timersRef.current.has(n.id))
                continue;
            const ms = (_a = n.autoDismissMs) !== null && _a !== void 0 ? _a : DEFAULT_DISMISS[n.type];
            const handle = setTimeout(() => {
                timersRef.current.delete(n.id);
                store.removeNotification(n.id);
            }, ms);
            timersRef.current.set(n.id, handle);
        }
    }, [state.notifications, store]);
    // On unmount, flush every outstanding timer so we don't leak setTimeout
    // handles past the component's lifetime.
    React.useEffect(() => () => {
        for (const t of timersRef.current.values())
            clearTimeout(t);
        timersRef.current.clear();
    }, []);
    if (state.notifications.length === 0)
        return null;
    return (React.createElement("div", { className: "pointer-events-none fixed right-4 top-14 z-[10000] flex w-full max-w-sm flex-col gap-2", role: "status", "aria-live": "polite" }, ((_a = state.notifications) !== null && _a !== void 0 ? _a : [])
        .slice(-DEFAULT_CONFIG.maxToastNotifications)
        .map((n) => {
        const Icon = TYPE_ICON[n.type];
        return (React.createElement("div", { key: n.id, className: cn("pointer-events-auto flex items-start gap-3 rounded-md border px-3 py-2.5 shadow-lg", "animate-in slide-in-from-right-4 fade-in-0 duration-200", TYPE_CLASS[n.type]), role: "alert" },
            React.createElement(Icon, { className: "mt-0.5 h-4 w-4 shrink-0" }),
            React.createElement("p", { className: "flex-1 text-sm leading-snug" }, n.message),
            React.createElement("button", { type: "button", onClick: () => store.removeNotification(n.id), "aria-label": "Dismiss notification", className: "-mr-0.5 -mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-current/70 transition-colors hover:bg-current/10 hover:text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/40" },
                React.createElement(X, { className: "h-3.5 w-3.5" }))));
    })));
};
//# sourceMappingURL=toast-container.js.map