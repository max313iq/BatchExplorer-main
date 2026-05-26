import * as React from "react";
import { MultiRegionStore } from "../../store/multi-region-store";
/**
 * Programmatic toast helper that can be called from anywhere with a store reference.
 *
 * @param store - The MultiRegionStore instance.
 * @param message - Text to display in the toast.
 * @param type - Toast severity: "success", "error", "warning", or "info" (default: "info").
 * @param durationMs - Optional auto-dismiss duration in ms. Uses default if omitted.
 */
export declare function showToast(store: MultiRegionStore, message: string, type?: "success" | "error" | "warning" | "info", durationMs?: number): void;
export declare const ToastContainer: React.FC;
//# sourceMappingURL=toast-container.d.ts.map