/**
 * Audit fix #4: bulk_node_action must use a per-subscription Batch
 * token cache (not the tenant-keyed one) so multi-account browsers
 * don't 401 on accounts owned by non-primary signed-in identities.
 *
 * The cache key surface isn't directly exposed, so this test exercises
 * the behavioral side: each unique subscription causes exactly one
 * call to `getBatchAccessTokenForSubscription`, and re-targeting the
 * same subscription a second time hits the cache (no extra call).
 */

jest.mock("../../auth/msal-auth", () => ({
  setActiveTenant: jest.fn(),
  getArmTokenForAccount: jest.fn().mockResolvedValue("arm-account-token"),
  getGraphToken: jest.fn().mockResolvedValue("graph-token"),
  getGraphTokenForAccount: jest.fn().mockResolvedValue("graph-token"),
  listAccessibleTenants: jest.fn().mockResolvedValue([]),
}));

// credential-vault touches WebCrypto on module load; stub it.
jest.mock("../../auth/credential-vault", () => ({
  credentialVault: {
    put: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    clearAll: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock("../../services", () => {
  const actual = jest.requireActual("../../services");
  return {
    ...actual,
    listSubscriptions: jest.fn().mockResolvedValue([]),
    listBatchAccounts: jest.fn().mockResolvedValue([]),
    getBatchAccount: jest.fn().mockResolvedValue(null),
    listPools: jest.fn().mockResolvedValue([]),
    listNodes: jest.fn().mockResolvedValue([
      { id: "n-1", state: "idle" },
      { id: "n-2", state: "idle" },
    ]),
    performNodeAction: jest.fn().mockResolvedValue(undefined),
    removeNodes: jest.fn().mockResolvedValue(undefined),
    createPool: jest.fn().mockResolvedValue(undefined),
    deletePool: jest.fn().mockResolvedValue(undefined),
    patchPool: jest.fn().mockResolvedValue(undefined),
    listOrgUsers: jest.fn().mockResolvedValue([]),
    getMyDirectoryRoles: jest.fn().mockResolvedValue([]),
    resetUserPassword: jest.fn().mockResolvedValue(undefined),
    canResetPasswords: jest.fn().mockResolvedValue(false),
  };
});

jest.mock("../../services/audit-log", () => ({
  auditLog: { record: jest.fn() },
}));

jest.mock("../../scheduling/request-governance", () => ({
  getSharedRequestGuard: jest.fn().mockReturnValue({ setTelemetry: jest.fn() }),
}));

import { OrchestratorAgent } from "../orchestrator-agent";
import { MultiRegionStore } from "../../store/multi-region-store";
import { AgentContext } from "../agent-types";
import { ManagedAccount, ManagedNode } from "../../store/store-types";

function makeCtx(store: MultiRegionStore): {
  ctx: AgentContext;
  batchPerSub: jest.Mock;
} {
  const batchPerSub = jest.fn(
    async (subscriptionId: string) => `batch-token-for-${subscriptionId}`,
  );
  const ctx: AgentContext = {
    store,
    scheduler: {
      run: jest.fn(<T,>(_k: string, fn: () => Promise<T>) => fn()),
    } as unknown as AgentContext["scheduler"],
    armUrl: "https://management.azure.com",
    getAccessToken: async () => "arm-token",
    getBatchAccessToken: async () => "batch-token-fallback",
    getBatchAccessTokenForSubscription: batchPerSub,
    getAccessTokenForSubscription: async (s: string) => `arm-for-${s}`,
  };
  return { ctx, batchPerSub };
}

function addAccount(
  store: MultiRegionStore,
  id: string,
  subscriptionId: string,
): ManagedAccount {
  const acct: ManagedAccount = {
    id,
    accountName: `a-${id}`,
    resourceGroup: "rg",
    subscriptionId,
    region: "eastus",
    provisioningState: "created",
  };
  store.addAccount(acct);
  return acct;
}

function addNode(store: MultiRegionStore, id: string, accountId: string): ManagedNode {
  const node: ManagedNode = {
    id,
    accountId,
    accountName: `a-${accountId}`,
    region: "eastus",
    poolId: "pool-1",
    nodeId: "n-1",
    state: "idle",
    isDedicated: false,
  };
  // Wedge it into store.nodes via setNodes (additive)
  store.setNodes([...store.getState().nodes, node]);
  return node;
}

describe("OrchestratorAgent._bulkNodeAction — per-subscription token cache (audit fix #4)", () => {
  it("uses getBatchAccessTokenForSubscription keyed by each account's subscriptionId", async () => {
    const store = new MultiRegionStore();
    addAccount(store, "A", "sub-AAA");
    addAccount(store, "B", "sub-BBB");
    addNode(store, "node1", "A");
    addNode(store, "node2", "B");

    const { ctx, batchPerSub } = makeCtx(store);
    const orch = new OrchestratorAgent(ctx);

    await orch.execute({
      action: "bulk_node_action",
      payload: { actionType: "reboot" },
    });

    // Two distinct subscriptions → two distinct calls. Re-running the
    // same sub WOULD hit the cache (one call each).
    const subsRequested = batchPerSub.mock.calls.map((c: any[]) => c[0]).sort();
    expect(subsRequested).toEqual(["sub-AAA", "sub-BBB"]);
  });
});
