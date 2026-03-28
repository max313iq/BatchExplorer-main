import * as React from "react";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import {
    useMultiRegionState,
    useMultiRegionStore,
} from "../../store/store-context";
import { MultiRegionStore } from "../../store/multi-region-store";
import { ToastNotification } from "../../store/store-types";
import { DEFAULT_CONFIG } from "./constants";

/**
 * Programmatic toast helper that can be called from anywhere with a store reference.
 *
 * @param store - The MultiRegionStore instance.
 * @param message - Text to display in the toast.
 * @param type - Toast severity: "success", "error", "warning", or "info" (default: "info").
 * @param durationMs - Optional auto-dismiss duration in ms. Uses default if omitted.
 */
export function showToast(
    store: MultiRegionStore,
    message: string,
    type: "success" | "error" | "warning" | "info" = "info",
    durationMs?: number
): void {
    store.addNotification({
        type,
        message,
        autoDismissMs: durationMs,
    });
}

const TYPE_MAP: Record<ToastNotification["type"], MessageBarType> = {
    success: MessageBarType.success,
    error: MessageBarType.error,
    warning: MessageBarType.warning,
    info: MessageBarType.info,
};

const DEFAULT_DISMISS: Record<ToastNotification["type"], number> = {
    success: 5000,
    info: 5000,
    warning: 8000,
    error: 10000,
};

let _toastStyleInjected = false;

function injectToastStyle() {
    if (_toastStyleInjected) return;
    _toastStyleInjected = true;
    const style = document.createElement("style");
    style.textContent = `
        @keyframes slideInRight {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
    `;
    document.head.appendChild(style);
}

export const ToastContainer: React.FC = () => {
    const state = useMultiRegionState();
    const store = useMultiRegionStore();

    React.useEffect(injectToastStyle, []);

    // Auto-dismiss timers
    React.useEffect(() => {
        const timers: ReturnType<typeof setTimeout>[] = [];
        for (const n of state.notifications) {
            const ms = n.autoDismissMs ?? DEFAULT_DISMISS[n.type];
            timers.push(setTimeout(() => store.removeNotification(n.id), ms));
        }
        return () => timers.forEach(clearTimeout);
    }, [state.notifications, store]);

    if (state.notifications.length === 0) return null;

    return (
        <div
            style={{
                position: "fixed",
                top: 56,
                right: 16,
                zIndex: 10000,
                display: "flex",
                flexDirection: "column",
                gap: 8,
                maxWidth: 400,
                minWidth: 300,
            }}
            role="status"
            aria-live="polite"
        >
            {state.notifications
                .slice(-DEFAULT_CONFIG.maxToastNotifications)
                .map((n) => (
                    <div
                        key={n.id}
                        style={{
                            animation: "slideInRight 0.3s ease-out",
                            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                            borderRadius: 4,
                        }}
                    >
                        <MessageBar
                            messageBarType={TYPE_MAP[n.type]}
                            onDismiss={() => store.removeNotification(n.id)}
                            dismissButtonAriaLabel="Close"
                            styles={{
                                root: {
                                    borderRadius: 4,
                                    background:
                                        n.type === "success"
                                            ? "#0e3b1e"
                                            : n.type === "error"
                                              ? "#3b0e0e"
                                              : n.type === "warning"
                                                ? "#3b2e0e"
                                                : "#0e2a3b",
                                },
                                text: { color: "#e0e0e0" },
                            }}
                        >
                            {n.message}
                        </MessageBar>
                    </div>
                ))}
        </div>
    );
};
