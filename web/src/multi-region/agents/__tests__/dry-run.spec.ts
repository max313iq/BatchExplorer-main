/**
 * Audit fix #20: dry-run mode. When `config.dryRun === true`, write-side
 * agents (PoolAgent + ProvisionerAgent) must compute the body, log a
 * `[dry-run]` line, and NOT call the real createPool / createBatchAccount.
 */

jest.mock("../../auth/msal-auth", () => ({
  setActiveTenant: jest.fn(),
}));

jest.mock("../../services/batch-service", () => ({
  createPool: jest.fn(),
  listPools: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../services/arm-service", () => ({
  createResourceGroup: jest.fn(),
  createBatchAccount: jest.fn(),
  ensureProvidersRegistered: jest.fn(),
}));

// Provisioner runs a subscription-validation probe through
// guardedFetch. We stub it to always allow.
jest.mock("../../scheduling/request-governance", () => ({
  guardedFetch: jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ state: "Enabled" }),
  })),
  getSharedRequestGuard: jest.fn().mockReturnValue({ setTelemetry: jest.fn() }),
}));

import { PoolAgent } from "../pool-agent";
import { ProvisionerAgent } from "../provisioner-agent";
import { AgentContext } from "../agent-types";
import { MultiRegionStore } from "../../store/multi-region-store";
import { RequestScheduler } from "../../scheduling/request-scheduler";
import { ManagedAccount } from "../../store/store-types";
import * as batchService from "../../services/batch-service";
import * as armService from "../../services/arm-service";

const mockedCreatePool = batchService.createPool as jest.MockedFunction<
  typeof batchService.createPool
>;
const mockedCreateRg = armService.createResourceGroup as jest.MockedFunction<
  typeof armService.createResourceGroup
>;
const mockedCreateAccount = armService.createBatchAccount as jest.MockedFunction<
  typeof armService.createBatchAccount
>;
const mockedEnsureProviders = armService.ensureProvidersRegistered as jest.MockedFunction<
  typeof armService.ensureProvidersRegistered
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
    getAccessToken: async () => "arm-token",
    getBatchAccessToken: async () => "batch-token",
  };
}

beforeEach(() => {
  mockedCreatePool.mockReset();
  mockedCreateRg.mockReset();
  mockedCreateAccount.mockReset();
  mockedEnsureProviders
    .mockReset()
    .mockResolvedValue({ newlyRegistered: [], already: [] } as any);
});

describe("PoolAgent dry-run", () => {
  it("does not call createPool when dryRun is true", async () => {
    const store = new MultiRegionStore();
    store.addAccount(makeAccount("a1"));

    const agent = new PoolAgent(makeCtx(store));
    const result = await agent.execute({
      accountIds: ["a1"],
      poolConfig: { id: "dry", vmSize: "Standard_NC6s_v3" },
      config: { dryRun: true },
    });

    expect(mockedCreatePool).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect((result.summary as Record<string, unknown>).dryRun).toBe(true);
    // A `[dry-run]` log line was emitted.
    const logs = store.getState().agentLogs;
    expect(logs.some((l) => l.message.startsWith("[dry-run]"))).toBe(true);
  });
});

describe("ProvisionerAgent dry-run", () => {
  it("does not call createResourceGroup / createBatchAccount when dryRun is true", async () => {
    const store = new MultiRegionStore();

    const agent = new ProvisionerAgent(makeCtx(store));
    const result = await agent.execute({
      subscriptionId: "11111111-2222-3333-4444-555555555555",
      regions: ["eastus"],
      config: { dryRun: true },
    });

    expect(mockedCreateRg).not.toHaveBeenCalled();
    expect(mockedCreateAccount).not.toHaveBeenCalled();
    expect(mockedEnsureProviders).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect((result.summary as Record<string, unknown>).dryRun).toBe(true);
    const logs = store.getState().agentLogs;
    expect(logs.some((l) => l.message.startsWith("[dry-run]"))).toBe(true);
  });
});
