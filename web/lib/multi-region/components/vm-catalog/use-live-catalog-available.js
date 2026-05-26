/**
 * useLiveCatalogAvailable — reactive read of whether the live VM-catalog
 * cache has data for a given subscription, so toggles that depend on
 * the catalog can disable themselves until the cache is warm.
 *
 * Why a hook (not a one-shot read):
 *   The cache populates asynchronously: dashboard-shell's boot prefetch
 *   + manual /vm-catalog visits fill it. A toggle that reads a stale
 *   "empty" snapshot once would stay disabled forever even after data
 *   arrives. Subscribing via subscribeQuotaCache fires whenever ANY key
 *   changes; we filter to the relevant key inside.
 *
 * Returns:
 *   - available: true if either the GPU-only or "all VM" entry has rows
 *   - count: total rows in whichever scope is populated (max of the two)
 *   - scope: which entry has data ("gpu" | "all" | "none")
 */
import * as React from "react";
import { cachePeek, subscribeQuotaCache, vmSkusCacheKey, } from "../../services/quota-service";
const EMPTY = {
    available: false,
    count: 0,
    scope: "none",
};
function read(subscriptionId) {
    var _a, _b;
    if (!subscriptionId)
        return EMPTY;
    const gpu = cachePeek(vmSkusCacheKey(subscriptionId, true));
    const all = cachePeek(vmSkusCacheKey(subscriptionId, false));
    const gpuCount = (_a = gpu === null || gpu === void 0 ? void 0 : gpu.value.length) !== null && _a !== void 0 ? _a : 0;
    const allCount = (_b = all === null || all === void 0 ? void 0 : all.value.length) !== null && _b !== void 0 ? _b : 0;
    if (allCount > 0) {
        return { available: true, count: allCount, scope: "all" };
    }
    if (gpuCount > 0) {
        return { available: true, count: gpuCount, scope: "gpu" };
    }
    return EMPTY;
}
export function useLiveCatalogAvailable(subscriptionId) {
    const [snapshot, setSnapshot] = React.useState(() => read(subscriptionId));
    React.useEffect(() => {
        setSnapshot(read(subscriptionId));
        // The cache pub/sub announces every key that changes; we ignore
        // unrelated keys to avoid pointless re-renders.
        return subscribeQuotaCache((key) => {
            if (!subscriptionId ||
                key === "*" ||
                key === vmSkusCacheKey(subscriptionId, true) ||
                key === vmSkusCacheKey(subscriptionId, false)) {
                setSnapshot(read(subscriptionId));
            }
        });
    }, [subscriptionId]);
    return snapshot;
}
//# sourceMappingURL=use-live-catalog-available.js.map