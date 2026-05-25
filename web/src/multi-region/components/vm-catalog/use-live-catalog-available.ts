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

import {
  cachePeek,
  ComputeVmSku,
  subscribeQuotaCache,
  vmSkusCacheKey,
} from "../../services/quota-service";

export interface LiveCatalogAvailability {
  available: boolean;
  count: number;
  scope: "gpu" | "all" | "none";
}

const EMPTY: LiveCatalogAvailability = {
  available: false,
  count: 0,
  scope: "none",
};

function read(subscriptionId: string | undefined): LiveCatalogAvailability {
  if (!subscriptionId) return EMPTY;
  const gpu = cachePeek<ComputeVmSku[]>(
    vmSkusCacheKey(subscriptionId, true),
  );
  const all = cachePeek<ComputeVmSku[]>(
    vmSkusCacheKey(subscriptionId, false),
  );
  const gpuCount = gpu?.value.length ?? 0;
  const allCount = all?.value.length ?? 0;
  if (allCount > 0) {
    return { available: true, count: allCount, scope: "all" };
  }
  if (gpuCount > 0) {
    return { available: true, count: gpuCount, scope: "gpu" };
  }
  return EMPTY;
}

export function useLiveCatalogAvailable(
  subscriptionId: string | undefined,
): LiveCatalogAvailability {
  const [snapshot, setSnapshot] = React.useState<LiveCatalogAvailability>(() =>
    read(subscriptionId),
  );
  React.useEffect(() => {
    setSnapshot(read(subscriptionId));
    // The cache pub/sub announces every key that changes; we ignore
    // unrelated keys to avoid pointless re-renders.
    return subscribeQuotaCache((key) => {
      if (
        !subscriptionId ||
        key === "*" ||
        key === vmSkusCacheKey(subscriptionId, true) ||
        key === vmSkusCacheKey(subscriptionId, false)
      ) {
        setSnapshot(read(subscriptionId));
      }
    });
  }, [subscriptionId]);
  return snapshot;
}
