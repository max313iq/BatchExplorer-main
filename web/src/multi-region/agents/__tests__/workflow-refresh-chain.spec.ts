/**
 * Focused test for audit fix #2 — `WorkflowAgent.executeRefreshChain`
 * previously dispatched "refresh_pools" and "refresh_accounts" which
 * the orchestrator never knew about. They now hit the real actions
 * `refresh_pool_info` and `refresh_account_info`.
 */

jest.mock("../../auth/msal-auth", () => ({
  setActiveTenant: jest.fn(),
}));

const mockExecute = jest.fn();
const mockCancel = jest.fn();
jest.mock("../orchestrator-agent", () => ({
  OrchestratorAgent: jest.fn().mockImplementation(() => ({
    execute: mockExecute,
    cancel: mockCancel,
  })),
}));

import { WorkflowAgent } from "../workflow-agent";
import { MultiRegionStore } from "../../store/multi-region-store";
import { AgentContext, AgentResult } from "../agent-types";
import { ManagedAccount } from "../../store/store-types";

function makeCtx(store: MultiRegionStore): AgentContext {
  return {
    store,
    scheduler: {} as any,
    armUrl: "https://management.azure.com",
    getAccessToken: async () => "tok",
    getBatchAccessToken: async () => "btok",
  };
}

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

beforeEach(() => {
  mockExecute.mockReset();
  mockCancel.mockReset();
});

describe("WorkflowAgent.executeRefreshChain — audit fix #2", () => {
  it("dispatches the real orchestrator action names (not refresh_pools/refresh_accounts)", async () => {
    const store = new MultiRegionStore();
    store.addAccount(makeAccount("a1", "created"));

    mockExecute
      .mockResolvedValueOnce({
        status: "completed",
        summary: {},
      } as AgentResult)
      .mockResolvedValueOnce({
        status: "completed",
        summary: {},
      } as AgentResult)
      .mockResolvedValueOnce({
        status: "completed",
        summary: {},
      } as AgentResult);

    const agent = new WorkflowAgent(makeCtx(store));
    await agent.executeRefreshChain("sub1");

    const actions = mockExecute.mock.calls.map((c: any[]) => c[0].action);
    expect(actions).toContain("discover_accounts");
    expect(actions).toContain("refresh_pool_info");
    expect(actions).toContain("refresh_account_info");
    // And NOT the broken names that previously fell through to
    // "Unknown action".
    expect(actions).not.toContain("refresh_pools");
    expect(actions).not.toContain("refresh_accounts");
  });
});
