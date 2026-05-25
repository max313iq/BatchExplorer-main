import { WorkflowAgent, WorkflowConfig } from "../workflow-agent";
import { MultiRegionStore } from "../../store/multi-region-store";
import { AgentContext, AgentResult } from "../agent-types";
import {
  AccountInfo,
  ManagedAccount,
  ManagedPool,
} from "../../store/store-types";

// Avoid persistence side effects from msal-auth.
jest.mock("../../auth/msal-auth", () => ({
  setActiveTenant: jest.fn(),
}));

// Mock OrchestratorAgent so we can control sub-step results without
// pulling in real ARM/Batch service calls or the construction-time
// auto-discover side effect. Audit fix #3 — WorkflowAgent now accepts
// an explicit parent OrchestratorAgent; the test still constructs
// WorkflowAgent without one so the legacy fallback fires this mock.
const mockExecute = jest.fn();
const mockCancel = jest.fn();
jest.mock("../orchestrator-agent", () => ({
  OrchestratorAgent: jest.fn().mockImplementation(() => ({
    execute: mockExecute,
    cancel: mockCancel,
  })),
}));

const makeAccount = (
  id: string,
  state: ManagedAccount["provisioningState"] = "created",
): ManagedAccount => ({
  id,
  accountName: `acct-${id}`,
  resourceGroup: "rg",
  subscriptionId: "sub1",
  region: "eastus",
  provisioningState: state,
});

const makePool = (id: string, accountId: string): ManagedPool => ({
  id,
  accountId,
  poolId: `pool-${id}`,
  provisioningState: "created",
  config: {},
});

const makeAccountInfo = (
  id: string,
  free: { lp: number; ded: number; lpUsed?: number; dedUsed?: number },
): AccountInfo => ({
  id,
  accountName: `acct-${id}`,
  subscriptionId: "sub1",
  region: "eastus",
  resourceGroup: "rg",
  dedicatedCoreQuota: 100,
  lowPriorityCoreQuota: 100,
  poolQuota: 10,
  activeJobAndJobScheduleQuota: 10,
  dedicatedCoresUsed: free.dedUsed ?? 0,
  lowPriorityCoresUsed: free.lpUsed ?? 0,
  poolCount: 0,
  dedicatedCoresFree: free.ded,
  lowPriorityCoresFree: free.lp,
  poolsFree: 10,
  dedicatedCoreQuotaPerVMFamilyEnforced: false,
});

function makeCtx(store: MultiRegionStore): AgentContext {
  return {
    store,
    scheduler: {} as any,
    armUrl: "https://management.azure.com",
    getAccessToken: async () => "tok",
    getBatchAccessToken: async () => "btok",
  };
}

const baseConfig: WorkflowConfig = {
  subscriptionId: "sub1",
  quotaType: "LowPriority",
  quotaLimit: 100,
  contactEmail: "u@example.com",
  poolConfig: { vmSize: "Standard_A1" },
};

beforeEach(() => {
  mockExecute.mockReset();
  mockCancel.mockReset();
});

describe("WorkflowAgent.execute (provisioning chain)", () => {
  it("runs discover then pool, returning completed with both summaries", async () => {
    const store = new MultiRegionStore();
    store.addAccount(makeAccount("a1", "created"));
    store.addAccount(makeAccount("a2", "created"));
    store.addAccount(makeAccount("a3", "pending")); // excluded from pool step

    mockExecute
      .mockResolvedValueOnce({
        status: "completed",
        summary: { discovered: 3 },
      } as AgentResult)
      .mockResolvedValueOnce({
        status: "completed",
        summary: { poolsCreated: 2 },
      } as AgentResult);

    const agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.execute(baseConfig);

    expect(result.status).toBe("completed");
    expect(result.summary.completedSteps).toEqual(["discover", "pool"]);
    expect(result.summary.discover).toEqual({ discovered: 3 });
    expect(result.summary.pool).toEqual({ poolsCreated: 2 });

    // Step 1 = discover
    expect(mockExecute).toHaveBeenNthCalledWith(1, {
      action: "discover_accounts",
      payload: { subscriptionId: "sub1" },
    });
    // Step 2 = create_pools, only "created" accounts are passed
    expect(mockExecute).toHaveBeenNthCalledWith(2, {
      action: "create_pools",
      payload: {
        accountIds: ["a1", "a2"],
        poolConfig: { vmSize: "Standard_A1" },
      },
    });

    // Final workflow state cleared
    const wf = store.getState().workflow;
    expect(wf.isRunning).toBe(false);
    expect(wf.currentStep).toBeNull();
    expect(wf.completedSteps).toEqual(["discover", "pool"]);
  });

  it("fails at discover step without invoking pool", async () => {
    const store = new MultiRegionStore();
    mockExecute.mockResolvedValueOnce({
      status: "failed",
      summary: { error: "boom-discover" },
    } as AgentResult);

    const agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.execute(baseConfig);

    expect(result.status).toBe("failed");
    expect(result.summary.failedStep).toBe("discover");
    expect(result.summary.error).toBe("boom-discover");
    expect(result.summary.completedSteps).toEqual([]);
    expect(mockExecute).toHaveBeenCalledTimes(1);

    const wf = store.getState().workflow;
    expect(wf.isRunning).toBe(false);
    expect(wf.failedStep).toBe("discover");
    expect(wf.error).toBe("boom-discover");
  });

  it("fails at pool step but reports discover as completed", async () => {
    const store = new MultiRegionStore();
    store.addAccount(makeAccount("a1", "created"));
    mockExecute
      .mockResolvedValueOnce({
        status: "completed",
        summary: { discovered: 1 },
      } as AgentResult)
      .mockResolvedValueOnce({
        status: "failed",
        summary: { error: "pool-failed" },
      } as AgentResult);

    const agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.execute(baseConfig);

    expect(result.status).toBe("failed");
    expect(result.summary.failedStep).toBe("pool");
    expect(result.summary.error).toBe("pool-failed");
    expect(result.summary.completedSteps).toEqual(["discover"]);

    const wf = store.getState().workflow;
    expect(wf.failedStep).toBe("pool");
  });

  it("fail-step path uses fallback error string when summary.error missing", async () => {
    const store = new MultiRegionStore();
    mockExecute.mockResolvedValueOnce({
      status: "failed",
      summary: {},
    } as AgentResult);

    const agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.execute(baseConfig);

    expect(result.status).toBe("failed");
    expect(result.summary.failedStep).toBe("discover");
    // _failStep stores `Step "<step>" failed` in the workflow store
    expect(store.getState().workflow.error).toBe('Step "discover" failed');
  });

  it("returns partial when cancel() fires before discover resolves", async () => {
    const store = new MultiRegionStore();
    let agent: WorkflowAgent | null = null;

    mockExecute.mockImplementationOnce(async () => {
      // simulate user clicking cancel mid-discover
      agent!.cancel();
      return {
        status: "completed",
        summary: {},
      } as AgentResult;
    });

    agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.execute(baseConfig);

    expect(result.status).toBe("partial");
    expect(result.summary.cancelled).toBe(true);
    expect(result.summary.completedSteps).toEqual([]);
    expect(mockCancel).toHaveBeenCalled();
    // Pool step never ran
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(store.getState().workflow.isRunning).toBe(false);
    expect(store.getState().workflow.error).toBe("Workflow cancelled by user");
  });

  it("returns partial when cancel fires between discover and pool", async () => {
    const store = new MultiRegionStore();
    store.addAccount(makeAccount("a1", "created"));

    let agent: WorkflowAgent | null = null;
    mockExecute
      .mockImplementationOnce(async () => ({
        status: "completed",
        summary: {},
      } as AgentResult))
      .mockImplementationOnce(async () => {
        // unreachable — cancel() fires first
        return { status: "completed", summary: {} } as AgentResult;
      });

    // Spy: trigger cancel right after discover sets currentStep -> pool
    const origSet = store.setWorkflowState.bind(store);
    jest
      .spyOn(store, "setWorkflowState")
      .mockImplementation((patch) => {
        origSet(patch);
        if (patch.currentStep === "pool" && agent) {
          agent.cancel();
        }
      });

    agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.execute(baseConfig);

    expect(result.status).toBe("partial");
    expect(result.summary.completedSteps).toEqual(["discover"]);
    // Only the discover call ran
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("catches unexpected exceptions and returns failed status", async () => {
    const store = new MultiRegionStore();
    mockExecute.mockRejectedValueOnce(new Error("kaboom"));

    const agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.execute(baseConfig);

    expect(result.status).toBe("failed");
    expect(result.summary.error).toBe("kaboom");
    expect(store.getState().workflow.isRunning).toBe(false);
    expect(store.getState().workflow.error).toBe("kaboom");
  });

  it("catches non-Error throws via String() fallback", async () => {
    const store = new MultiRegionStore();
    mockExecute.mockRejectedValueOnce("string-fail");

    const agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.execute(baseConfig);

    expect(result.status).toBe("failed");
    expect(result.summary.error).toBe("string-fail");
  });
});

describe("WorkflowAgent.executeRefreshChain", () => {
  it("runs all four refresh steps in order with success", async () => {
    const store = new MultiRegionStore();
    store.addAccount(makeAccount("a1", "created"));
    store.addAccount(makeAccount("a2", "created"));

    mockExecute
      .mockResolvedValueOnce({
        status: "completed",
        summary: { d: 1 },
      } as AgentResult) // discover
      .mockResolvedValueOnce({
        status: "completed",
        summary: { rp: 1 },
      } as AgentResult) // refresh_pools
      .mockResolvedValueOnce({
        status: "completed",
        summary: { ra: 1 },
      } as AgentResult); // refresh_accounts

    const agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.executeRefreshChain("sub1");

    expect(result.status).toBe("completed");
    expect(result.summary.completedSteps).toEqual([
      "discover",
      "refreshPools",
      "refreshAccounts",
      "detectUnusedQuota",
    ]);
    const stepResults = result.summary.stepResults as Record<string, unknown>;
    expect(stepResults.discover).toEqual({ d: 1 });
    expect(stepResults.refreshPools).toEqual({ rp: 1 });
    expect(stepResults.refreshAccounts).toEqual({ ra: 1 });
    expect(stepResults.unusedQuota).toBeDefined();

    // Audit fix #2: the workflow agent used "refresh_pools" /
    // "refresh_accounts" — neither exists on the orchestrator. They
    // now dispatch the real action names "refresh_pool_info" and
    // "refresh_account_info".
    expect(mockExecute).toHaveBeenNthCalledWith(1, {
      action: "discover_accounts",
      payload: { subscriptionId: "sub1" },
    });
    expect(mockExecute).toHaveBeenNthCalledWith(2, {
      action: "refresh_pool_info",
      payload: { accountIds: ["a1", "a2"] },
    });
    expect(mockExecute).toHaveBeenNthCalledWith(3, {
      action: "refresh_account_info",
      payload: { accountIds: ["a1", "a2"] },
    });
  });

  it("short-circuits when discover fails in the refresh chain", async () => {
    const store = new MultiRegionStore();
    mockExecute.mockResolvedValueOnce({
      status: "failed",
      summary: { error: "discover-broke" },
    } as AgentResult);

    const agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.executeRefreshChain("sub1");

    expect(result.status).toBe("failed");
    expect(result.summary.failedStep).toBe("discover");
    expect(result.summary.completedSteps).toEqual([]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("returns partial when cancelled between refresh steps", async () => {
    const store = new MultiRegionStore();
    store.addAccount(makeAccount("a1", "created"));

    let agent: WorkflowAgent | null = null;
    mockExecute
      .mockImplementationOnce(async () => ({
        status: "completed",
        summary: {},
      } as AgentResult))
      .mockImplementationOnce(async () => {
        // cancel between refresh_pools and refresh_accounts
        agent!.cancel();
        return { status: "completed", summary: {} } as AgentResult;
      });

    agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.executeRefreshChain("sub1");

    expect(result.status).toBe("partial");
    expect(result.summary.cancelled).toBe(true);
    // Two steps registered before cancel landed
    const completed = result.summary.completedSteps as string[];
    expect(completed).toContain("discover");
    expect(completed).toContain("refreshPools");
    expect(completed).not.toContain("detectUnusedQuota");
  });

  it("captures unexpected exceptions in the refresh chain", async () => {
    const store = new MultiRegionStore();
    mockExecute.mockRejectedValueOnce(new Error("network-down"));

    const agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.executeRefreshChain("sub1");

    expect(result.status).toBe("failed");
    expect(result.summary.error).toBe("network-down");
  });

  it("detectUnusedQuota counts accounts with free cores and no pools/usage", async () => {
    const store = new MultiRegionStore();
    store.addAccount(makeAccount("a1", "created"));
    store.addAccount(makeAccount("a2", "created"));
    store.addAccount(makeAccount("a3", "created"));
    // a1: free LP, no pool, no usage -> unused
    // a2: has pool -> excluded
    // a3: has usage -> excluded
    store.setAccountInfos([
      makeAccountInfo("a1", { lp: 50, ded: 0 }),
      makeAccountInfo("a2", { lp: 50, ded: 50 }),
      makeAccountInfo("a3", { lp: 50, ded: 0, lpUsed: 10 }),
    ]);
    store.addPool(makePool("p2", "a2"));

    mockExecute
      .mockResolvedValueOnce({ status: "completed", summary: {} } as AgentResult)
      .mockResolvedValueOnce({ status: "completed", summary: {} } as AgentResult)
      .mockResolvedValueOnce({ status: "completed", summary: {} } as AgentResult);

    const agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.executeRefreshChain("sub1");

    const stepResults = result.summary.stepResults as Record<string, any>;
    expect(stepResults.unusedQuota.accountsWithUnusedQuota).toBe(1);
    expect(stepResults.unusedQuota.accounts[0].accountId).toBe("a1");
    expect(stepResults.unusedQuota.accounts[0].freeLpCores).toBe(50);
  });

  it("detectUnusedQuota skips accounts with zero free cores", async () => {
    const store = new MultiRegionStore();
    store.addAccount(makeAccount("a1", "created"));
    store.setAccountInfos([makeAccountInfo("a1", { lp: 0, ded: 0 })]);
    mockExecute
      .mockResolvedValueOnce({ status: "completed", summary: {} } as AgentResult)
      .mockResolvedValueOnce({ status: "completed", summary: {} } as AgentResult)
      .mockResolvedValueOnce({ status: "completed", summary: {} } as AgentResult);

    const agent = new WorkflowAgent(makeCtx(store));
    const result = await agent.executeRefreshChain("sub1");

    const stepResults = result.summary.stepResults as Record<string, any>;
    expect(stepResults.unusedQuota.accountsWithUnusedQuota).toBe(0);
    expect(stepResults.unusedQuota.accounts).toEqual([]);
  });
});

describe("WorkflowAgent.cancel", () => {
  it("cancel() sets internal flag and forwards to orchestrator", () => {
    const store = new MultiRegionStore();
    const agent = new WorkflowAgent(makeCtx(store));
    agent.cancel();
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });
});
