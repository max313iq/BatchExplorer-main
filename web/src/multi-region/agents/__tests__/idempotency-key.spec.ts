/**
 * Audit fix #19: idempotency-key handling in `PoolAgent.execute`.
 * Same key → same derived pool name across retries; missing key →
 * legacy random behavior (poolId === caller's config.id ?? "pool").
 */

jest.mock("../../auth/msal-auth", () => ({
  setActiveTenant: jest.fn(),
}));

jest.mock("../../services/batch-service", () => ({
  createPool: jest.fn(),
  listPools: jest.fn().mockResolvedValue([]),
}));

import { PoolAgent } from "../pool-agent";
import { AgentContext } from "../agent-types";
import { MultiRegionStore } from "../../store/multi-region-store";
import { RequestScheduler } from "../../scheduling/request-scheduler";
import { ManagedAccount } from "../../store/store-types";
import * as batchService from "../../services/batch-service";

const mockedCreatePool = batchService.createPool as jest.MockedFunction<
  typeof batchService.createPool
>;

function makeAccount(id: string): ManagedAccount {
  return {
    id,
    accountName: `acct-${id}`,
    resourceGroup: "rg",
    subscriptionId: "sub1",
    region: "eastus",
    provisioningState: "created",
  };
}

function makeCtx(store: MultiRegionStore): AgentContext {
  return {
    store,
    scheduler: new RequestScheduler({
      concurrency: 1,
      delayMs: 0,
      retryAttempts: 0,
      retryBackoffSeconds: [],
      jitterPct: 0,
    }),
    armUrl: "https://management.azure.com",
    getAccessToken: async () => "tok",
    getBatchAccessToken: async () => "btok",
  };
}

beforeEach(() => {
  mockedCreatePool.mockReset().mockResolvedValue(undefined);
});

describe("PoolAgent.execute — idempotency key (audit fix #19)", () => {
  it("derives the same pool name on retry when idempotencyKey is set", async () => {
    const store = new MultiRegionStore();
    store.addAccount(makeAccount("a1"));

    const agent = new PoolAgent(makeCtx(store));

    await agent.execute({
      accountIds: ["a1"],
      poolConfig: { id: "myprefix", vmSize: "Standard_NC6s_v3" },
      config: { idempotencyKey: "request-42" },
    });
    const idFirst = (mockedCreatePool.mock.calls[0][1] as { id: string }).id;

    // Retry with the same key — should produce the SAME pool name.
    await agent.execute({
      accountIds: ["a1"],
      poolConfig: { id: "myprefix", vmSize: "Standard_NC6s_v3" },
      config: { idempotencyKey: "request-42" },
    });
    const idSecond = (mockedCreatePool.mock.calls[1][1] as { id: string }).id;

    expect(idFirst).toBe(idSecond);
    expect(idFirst.startsWith("myprefix-")).toBe(true);
  });

  it("derives different names for different idempotency keys", async () => {
    const store = new MultiRegionStore();
    store.addAccount(makeAccount("a1"));

    const agent = new PoolAgent(makeCtx(store));
    await agent.execute({
      accountIds: ["a1"],
      poolConfig: { id: "x", vmSize: "Standard_NC6s_v3" },
      config: { idempotencyKey: "key-A" },
    });
    await agent.execute({
      accountIds: ["a1"],
      poolConfig: { id: "x", vmSize: "Standard_NC6s_v3" },
      config: { idempotencyKey: "key-B" },
    });
    const idA = (mockedCreatePool.mock.calls[0][1] as { id: string }).id;
    const idB = (mockedCreatePool.mock.calls[1][1] as { id: string }).id;
    expect(idA).not.toBe(idB);
  });

  it("uses the configured poolId verbatim when no idempotency key is set", async () => {
    const store = new MultiRegionStore();
    store.addAccount(makeAccount("a1"));

    const agent = new PoolAgent(makeCtx(store));
    await agent.execute({
      accountIds: ["a1"],
      poolConfig: { id: "plain", vmSize: "Standard_NC6s_v3" },
    });

    const id = (mockedCreatePool.mock.calls[0][1] as { id: string }).id;
    expect(id).toBe("plain");
  });
});
