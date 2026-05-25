/**
 * Tests for performTenantSwitch's rollback path — specifically that
 * popup cancellation restores the subscriptions snapshot taken at
 * entry.
 */

import type { AzureLoginAccount } from "../../store/store-types";

// Mock the msal-auth module so the tenant-switch path doesn't try to
// initialise a real PublicClientApplication.
jest.mock("../msal-auth", () => ({
  __esModule: true,
  getArmTokenForAccount: jest.fn(),
  listSubscriptionsForAccount: jest.fn(),
  loginAccount: jest.fn(),
  setActiveTenant: jest.fn(),
}));

// Mock the audit-log + tenant-changed-event imports. These come from
// outside the auth folder; the tests only care that they don't blow
// up when called.
jest.mock("../../hooks/tenant-changed-event", () => ({
  __esModule: true,
  TENANT_CHANGED_EVENT: "azbm-tenant-changed",
}));
jest.mock("../../services/audit-log", () => ({
  __esModule: true,
  auditLog: { record: jest.fn() },
}));

import {
  getArmTokenForAccount,
  loginAccount,
  listSubscriptionsForAccount,
} from "../msal-auth";
import { performTenantSwitch } from "../perform-tenant-switch";

function makeAccount(): AzureLoginAccount {
  return {
    homeAccountId: "home-1",
    username: "test@contoso.com",
    name: "Test User",
    tenantId: "home-tenant",
    activeTenantId: "home-tenant",
    environment: "login.microsoftonline.com",
    subscriptions: [
      { subscriptionId: "sub-A", displayName: "Sub A", state: "Enabled", tenantId: "home-tenant" },
      { subscriptionId: "sub-B", displayName: "Sub B", state: "Enabled", tenantId: "home-tenant" },
    ],
    subscriptionCount: 2,
    status: "active",
    error: null,
    signedOut: false,
    addedAt: new Date().toISOString(),
    tenants: [
      { tenantId: "home-tenant", displayName: "Home" },
      { tenantId: "guest-tenant", displayName: "Guest" },
    ],
  } as unknown as AzureLoginAccount;
}

function makeStore() {
  const updates: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];
  const tenantSets: Array<{ home: string; tenant: string }> = [];
  return {
    updates,
    notifications,
    tenantSets,
    setActiveTenant(home: string, tenant: string) {
      tenantSets.push({ home, tenant });
    },
    updateAzureAccount(_home: string, patch: Record<string, unknown>) {
      updates.push(patch);
    },
    addNotification(n: Record<string, unknown>) {
      notifications.push(n);
    },
  } as never;
}

describe("performTenantSwitch rollback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("restores the subscriptions snapshot when the re-auth popup is cancelled", async () => {
    (getArmTokenForAccount as jest.Mock)
      // First silent acquire fails with reauth-required.
      .mockRejectedValueOnce(new Error("interaction_required"));
    // Popup is cancelled.
    (loginAccount as jest.Mock).mockRejectedValueOnce(
      new Error("Sign-in cancelled — popup was closed"),
    );

    const account = makeAccount();
    const originalSubs = account.subscriptions.slice();
    const store = makeStore();

    const result = await performTenantSwitch(account, "guest-tenant", store, {
      source: "header-switcher",
    });

    expect(result).toEqual({ stale: false, subscriptionsLoaded: 0 });
    // Final store update must restore subscriptions to the snapshot.
    const lastUpdate = (store as unknown as { updates: Array<Record<string, unknown>> })
      .updates.at(-1)!;
    expect(lastUpdate.status).toBe("active");
    expect(lastUpdate.subscriptions).toEqual(originalSubs);
    expect(lastUpdate.subscriptionCount).toBe(2);

    // listSubscriptionsForAccount must NEVER have been called — the
    // popup cancellation should short-circuit before we hit ARM.
    expect(listSubscriptionsForAccount).not.toHaveBeenCalled();
  });

  it("uses structuredClone (or JSON deep-copy) so a mutation to original.subscriptions does not leak into the snapshot", async () => {
    (getArmTokenForAccount as jest.Mock).mockRejectedValueOnce(
      new Error("interaction_required"),
    );
    (loginAccount as jest.Mock).mockRejectedValueOnce(
      new Error("cancelled"),
    );

    const account = makeAccount();
    const store = makeStore();

    const promise = performTenantSwitch(account, "guest-tenant", store, {
      source: "drawer",
    });
    // Mutate the original BEFORE the rollback writes back. Snapshot
    // must be insulated.
    account.subscriptions.length = 0;
    account.subscriptions.push({
      subscriptionId: "MUTATED",
      displayName: "do not see me",
      state: "Enabled",
      tenantId: "x",
    });
    await promise;

    const lastUpdate = (store as unknown as { updates: Array<Record<string, unknown>> })
      .updates.at(-1)!;
    const restored = lastUpdate.subscriptions as Array<{ subscriptionId: string }>;
    expect(restored.map((s) => s.subscriptionId)).toEqual(["sub-A", "sub-B"]);
  });
});
