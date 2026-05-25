/**
 * Shared constants for the cross-page tenant-changed event.
 *
 * Lives in `hooks/` (a leaf module with no internal deps) so both
 * `use-tenant-change.ts` (the listener hook) and
 * `auth/perform-tenant-switch.ts` (the emitter helper) can import the
 * constant without forcing a circular dep through
 * `components/azure-accounts/azure-accounts-page.tsx` — which used to
 * own the constant inline.
 *
 * `azure-accounts-page.tsx` still re-exports `TENANT_CHANGED_EVENT`
 * from this module so existing imports (and external doc references)
 * keep working without churn.
 */

export const TENANT_CHANGED_EVENT = "azbm:tenant-changed";

export interface TenantChangedDetail {
  homeAccountId: string;
  tenantId: string;
  fromTenantId: string | null;
}
