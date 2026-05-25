/**
 * Subscribe to tenant-switch events broadcast by the Azure Accounts
 * page. Pages with live state tied to a particular account / tenant
 * (e.g. EA Sub Quick's billing-account cascade, Pool Info's pool
 * list) use this to refresh themselves when the operator switches
 * the active tenant in the sidebar — instead of silently rendering
 * stale data scoped to the old tenant.
 *
 * `forAccountId` is optional: pass it to filter so the callback only
 * fires when the switch was for *this* account. Omit it to receive
 * every tenant-change event regardless of which account changed.
 *
 * @example Per-account listener
 * ```tsx
 * function PoolInfoPage() {
 *   const account = useSelectedAccount();
 *   const reload = useCallback(() => void reloadPools(), []);
 *
 *   // Only fires when the tenant for this specific account changes.
 *   useTenantChange(account?.homeAccountId, reload);
 *
 *   return <PoolsTable ... />;
 * }
 * ```
 *
 * @example Global listener (any account)
 * ```tsx
 * function DashboardShell() {
 *   useTenantChange(undefined, ({ homeAccountId, tenantId, fromTenantId }) => {
 *     telemetry.track("tenant-switched", {
 *       homeAccountId,
 *       tenantId,
 *       fromTenantId,
 *     });
 *     // Optionally trigger a global cache invalidation here.
 *   });
 *   ...
 * }
 * ```
 */
import * as React from "react";

import {
  TENANT_CHANGED_EVENT,
  type TenantChangedDetail,
} from "./tenant-changed-event";

export type { TenantChangedDetail };

export function useTenantChange(
  forAccountId: string | undefined,
  onChange: (detail: TenantChangedDetail) => void,
): void {
  // Stash the callback in a ref so the listener always sees the
  // latest closure without the effect re-binding on every render.
  const cbRef = React.useRef(onChange);
  React.useEffect(() => {
    cbRef.current = onChange;
  }, [onChange]);

  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<TenantChangedDetail>).detail;
      if (!detail) return;
      if (forAccountId && detail.homeAccountId !== forAccountId) return;
      cbRef.current(detail);
    };
    window.addEventListener(TENANT_CHANGED_EVENT, handler);
    return () => {
      window.removeEventListener(TENANT_CHANGED_EVENT, handler);
    };
  }, [forAccountId]);
}
