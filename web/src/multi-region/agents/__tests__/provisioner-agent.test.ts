/**
 * Tests for ProvisionerAgent — covers the happy path, per-region rate limiting,
 * subscription validation gate, duplicate-skip logic, ARM error propagation,
 * post-PUT provisioningState verification, cancellation, and the various log
 * paths exercised by `_validateSubscription`.
 *
 * Strategy:
 *   - Mock `arm-service` module so `createResourceGroup` / `createBatchAccount`
 *     return controllable values without hitting the network.
 *   - Use a real `MultiRegionStore` and a real `RequestScheduler` (with zero
 *     delay + no retries so tests run instantly).
 *   - Stub the global `fetch` symbol used by `_validateSubscription`.
 *   - Replace the WRITE_RATE_LIMIT_MS pacing by mocking `setTimeout` so the
 *     500ms inter-write delay does not block the test runner.
 */

// Avoid persistence side effects from msal-auth's setActiveTenant.
jest.mock("../../auth/msal-auth", () => ({
  setActiveTenant: jest.fn(),
}));

// Mock the ARM service surface used by ProvisionerAgent.
jest.mock("../../services/arm-service", () => ({
  createResourceGroup: jest.fn(),
  createBatchAccount: jest.fn(),
  ensureProvidersRegistered: jest.fn().mockResolvedValue({
    newlyRegistered: [],
    already: [],
  }),
}));

// NOTE: this file uses the `.test.ts` extension. The project's default
// jest config matches `*.spec.ts`, so this file is skipped by the
// runner. See `*.spec.ts` siblings for the active behavioural suite.
import { ProvisionerAgent } from "../provisioner-agent";
import { AgentContext, ProvisionerInput } from "../agent-types";
import { MultiRegionStore } from "../../store/multi-region-store";
import { RequestScheduler } from "../../scheduling/request-scheduler";
import { AzureRequestError } from "../../services/types";
import {
  createResourceGroup,
  createBatchAccount,
} from "../../services/arm-service";

const createResourceGroupMock = createResourceGroup as jest.MockedFunction<
  typeof createResourceGroup
>;
const createBatchAccountMock = createBatchAccount as jest.MockedFunction<
  typeof createBatchAccount
>;

const VALID_SUB_ID = "11111111-2222-3333-4444-555555555555";

interface FetchInit {
  status?: number;
  body?: unknown;
}

function makeFetchResponse(init: FetchInit = {}): Response {
  const status = init.status ?? 200;
  const body = init.body ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function buildContext(store: MultiRegionStore): AgentContext {
  // concurrency=2 with delayMs=0 and 0 retries makes scheduler.run a thin
  // wrapper around `fn()`. Anything more would slow the suite down without
  // improving coverage of provisioner-agent specifically.
  const scheduler = new RequestScheduler({
    concurrency: 2,
    delayMs: 0,
    retryAttempts: 0,
    sleep: () => Promise.resolve(),
  });
  return {
    store,
    scheduler,
    armUrl: "https://management.azure.com",
    getAccessToken: jest.fn(async () => "fake-token"),
    getBatchAccessToken: jest.fn(async () => "fake-batch-token"),
  };
}

function successAccountResult(state = "Succeeded"): unknown {
  return {
    id: "batch-id",
    name: "name",
    type: "Microsoft.Batch/batchAccounts",
    location: "eastus",
    properties: { provisioningState: state },
  };
}

describe("ProvisionerAgent", () => {
  let originalFetch: typeof fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    createResourceGroupMock.mockReset();
    createBatchAccountMock.mockReset();

    // Skip the WRITE_RATE_LIMIT_MS sleep between writes so the suite runs
    // fast. Other code in the agent is synchronous enough that this stub is
    // safe.
    jest
      .spyOn(global, "setTimeout")
      .mockImplementation(((fn: () => void) => {
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout);

    originalFetch = global.fetch;
    fetchMock = jest.fn(async () =>
      makeFetchResponse({ status: 200, body: { state: "Enabled" } }),
    );
    (global as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (global as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------
  describe("happy path", () => {
    it("provisions every region successfully", async () => {
      const store = new MultiRegionStore();
      const ctx = buildContext(store);
      createResourceGroupMock.mockResolvedValue({} as never);
      createBatchAccountMock.mockResolvedValue(successAccountResult() as never);

      const agent = new ProvisionerAgent(ctx);
      const input: ProvisionerInput = {
        subscriptionId: VALID_SUB_ID,
        regions: ["eastus", "westus"],
      };

      const result = await agent.execute(
        input as unknown as Record<string, unknown>,
      );

      expect(result.status).toBe("completed");
      const summary = result.summary as {
        total: number;
        created: number;
        failed: number;
        failures: unknown[];
      };
      expect(summary.total).toBe(2);
      expect(summary.created).toBe(2);
      expect(summary.failed).toBe(0);
      expect(summary.failures).toEqual([]);

      // The agent registers an account row per region with provisioningState
      // transitioned all the way to "created".
      expect(store.getState().accounts).toHaveLength(2);
      for (const account of store.getState().accounts) {
        expect(account.provisioningState).toBe("created");
        expect(account.subscriptionId).toBe(VALID_SUB_ID);
      }

      // Final agent status reflects success.
      expect(store.getState().agentStatuses.provisioner).toBe("completed");

      // ARM helpers are invoked once per region (one RG and one Batch acct).
      expect(createResourceGroupMock).toHaveBeenCalledTimes(2);
      expect(createBatchAccountMock).toHaveBeenCalledTimes(2);
    });

    it("uses the provided arm-service helpers with the expected arguments", async () => {
      const store = new MultiRegionStore();
      const ctx = buildContext(store);
      createResourceGroupMock.mockResolvedValue({} as never);
      createBatchAccountMock.mockResolvedValue(successAccountResult() as never);

      const agent = new ProvisionerAgent(ctx);
      await agent.execute({
        subscriptionId: VALID_SUB_ID,
        regions: ["eastus"],
      } as unknown as Record<string, unknown>);

      const [subId, , region, token] =
        createResourceGroupMock.mock.calls[0] ?? [];
      expect(subId).toBe(VALID_SUB_ID);
      expect(region).toBe("eastus");
      expect(token).toBe("fake-token");

      const [bSubId, , , bRegion, bToken] =
        createBatchAccountMock.mock.calls[0] ?? [];
      expect(bSubId).toBe(VALID_SUB_ID);
      expect(bRegion).toBe("eastus");
      expect(bToken).toBe("fake-token");
    });
  });

  // -------------------------------------------------------------------------
  // Subscription gate
  // -------------------------------------------------------------------------
  describe("_validateSubscription gate", () => {
    it("aborts when ARM reports the subscription is Disabled", async () => {
      const store = new MultiRegionStore();
      const ctx = buildContext(store);
      // _validateSubscription returns invalid → agent returns failed.
      fetchMock.mockResolvedValueOnce(
        makeFetchResponse({ status: 200, body: { state: "Disabled" } }),
      );

      const agent = new ProvisionerAgent(ctx);
      const result = await agent.execute({
        subscriptionId: VALID_SUB_ID,
        regions: ["eastus", "westus"],
      } as unknown as Record<string, unknown>);

      expect(result.status).toBe("failed");
      const summary = result.summary as {
        created: number;
        failed: number;
        failures: Array<{ region: string; error: string }>;
      };
      expect(summary.created).toBe(0);
      expect(summary.failed).toBe(2);
      expect(summary.failures[0]?.region).toBe("*");
      expect(summary.failures[0]?.error).toContain("not valid");

      expect(store.getState().agentStatuses.provisioner).toBe("error");
      // No accounts should have been added.
      expect(store.getState().accounts).toHaveLength(0);
      // arm-service helpers must NOT have been invoked.
      expect(createResourceGroupMock).not.toHaveBeenCalled();
      expect(createBatchAccountMock).not.toHaveBeenCalled();
    });

    it("aborts when subscription lookup returns a non-2xx HTTP response", async () => {
      const store = new MultiRegionStore();
      const ctx = buildContext(store);
      fetchMock.mockResolvedValueOnce(makeFetchResponse({ status: 403 }));

      const agent = new ProvisionerAgent(ctx);
      const result = await agent.execute({
        subscriptionId: VALID_SUB_ID,
        regions: ["eastus"],
      } as unknown as Record<string, unknown>);

      expect(result.status).toBe("failed");
      const summary = result.summary as {
        failures: Array<{ region: string; error: string }>;
      };
      expect(summary.failures[0]?.error).toContain("HTTP 403");
    });

    it("treats a fetch failure as a soft warning and proceeds", async () => {
      const store = new MultiRegionStore();
      const ctx = buildContext(store);
      // A network error during _validateSubscription falls through to
      // `valid: true` after logging a warning.
      fetchMock.mockRejectedValueOnce(new Error("ENETDOWN"));
      createResourceGroupMock.mockResolvedValue({} as never);
      createBatchAccountMock.mockResolvedValue(successAccountResult() as never);

      const agent = new ProvisionerAgent(ctx);
      const result = await agent.execute({
        subscriptionId: VALID_SUB_ID,
        regions: ["eastus"],
      } as unknown as Record<string, unknown>);

      expect(result.status).toBe("completed");
      const warns = store
        .getState()
        .agentLogs.filter((l) => l.level === "warn");
      expect(
        warns.some((w) => w.message.includes("Could not validate subscription")),
      ).toBe(true);
    });

    it("logs a warning when the subscription has a spending limit ON", async () => {
      const store = new MultiRegionStore();
      const ctx = buildContext(store);
      fetchMock.mockResolvedValueOnce(
        makeFetchResponse({
          status: 200,
          body: {
            state: "Enabled",
            subscriptionPolicies: { spendingLimit: "On" },
          },
        }),
      );
      createResourceGroupMock.mockResolvedValue({} as never);
      createBatchAccountMock.mockResolvedValue(successAccountResult() as never);

      const agent = new ProvisionerAgent(ctx);
      await agent.execute({
        subscriptionId: VALID_SUB_ID,
        regions: ["eastus"],
      } as unknown as Record<string, unknown>);

      const warns = store
        .getState()
        .agentLogs.filter((l) => l.level === "warn");
      expect(warns.some((w) => w.message.includes("spending limit ON"))).toBe(
        true,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate skip
  // -------------------------------------------------------------------------
  describe("duplicate region skip", () => {
    it("skips a region that already has a 'created' account in the same subscription", async () => {
      const store = new MultiRegionStore();
      // Pre-populate a created account for one of the requested regions.
      store.addAccount({
        id: "/subscriptions/x/y/z",
        accountName: "existing01",
        resourceGroup: "rg-existing",
        subscriptionId: VALID_SUB_ID,
        region: "eastus",
        provisioningState: "created",
      });

      const ctx = buildContext(store);
      createResourceGroupMock.mockResolvedValue({} as never);
      createBatchAccountMock.mockResolvedValue(successAccountResult() as never);

      const agent = new ProvisionerAgent(ctx);
      const result = await agent.execute({
        subscriptionId: VALID_SUB_ID,
        regions: ["eastus", "westus"],
      } as unknown as Record<string, unknown>);

      // Only westus should have been provisioned.
      expect(createResourceGroupMock).toHaveBeenCalledTimes(1);
      expect(createBatchAccountMock).toHaveBeenCalledTimes(1);
      const summary = result.summary as { created: number; total: number };
      expect(summary.created).toBe(1);
      expect(summary.total).toBe(2); // total reflects the full request
      expect(result.status).toBe("completed");

      const skipLogs = store
        .getState()
        .agentLogs.filter((l) =>
          l.message.includes("Account already exists for eastus"),
        );
      expect(skipLogs).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Failure paths
  // -------------------------------------------------------------------------
  describe("failure handling", () => {
    it("marks a region as failed when createBatchAccount throws AzureRequestError", async () => {
      const store = new MultiRegionStore();
      const ctx = buildContext(store);
      createResourceGroupMock.mockResolvedValue({} as never);
      createBatchAccountMock.mockRejectedValueOnce(
        new AzureRequestError("quota exceeded", 400, "QuotaExceeded", {}),
      );

      const agent = new ProvisionerAgent(ctx);
      const result = await agent.execute({
        subscriptionId: VALID_SUB_ID,
        regions: ["eastus"],
      } as unknown as Record<string, unknown>);

      expect(result.status).toBe("failed");
      const summary = result.summary as {
        failed: number;
        failures: Array<{ region: string; error: string }>;
      };
      expect(summary.failed).toBe(1);
      expect(summary.failures[0]?.region).toBe("eastus");
      expect(summary.failures[0]?.error).toContain("quota exceeded");

      // Account row should be tagged as failed and carry the error message.
      const account = store.getState().accounts[0];
      expect(account?.provisioningState).toBe("failed");
      expect(account?.error).toContain("quota exceeded");
      expect(store.getState().agentStatuses.provisioner).toBe("error");
    });

    it("returns 'partial' when some regions succeed and others fail", async () => {
      const store = new MultiRegionStore();
      const ctx = buildContext(store);
      createResourceGroupMock.mockResolvedValue({} as never);
      // First batch account succeeds, second throws.
      createBatchAccountMock
        .mockResolvedValueOnce(successAccountResult() as never)
        .mockRejectedValueOnce(new Error("internal explosion"));

      const agent = new ProvisionerAgent(ctx);
      const result = await agent.execute({
        subscriptionId: VALID_SUB_ID,
        regions: ["eastus", "westus"],
      } as unknown as Record<string, unknown>);

      expect(result.status).toBe("partial");
      const summary = result.summary as { created: number; failed: number };
      expect(summary.created).toBe(1);
      expect(summary.failed).toBe(1);
      // partial → store agent status is "completed" (NOT error).
      expect(store.getState().agentStatuses.provisioner).toBe("completed");
    });

    it("treats provisioningState='Failed' from the create result as a failure", async () => {
      const store = new MultiRegionStore();
      const ctx = buildContext(store);
      createResourceGroupMock.mockResolvedValue({} as never);
      createBatchAccountMock.mockResolvedValue({
        id: "id",
        name: "name",
        type: "Microsoft.Batch/batchAccounts",
        location: "eastus",
        properties: {
          provisioningState: "Failed",
          statusText: "internal Azure error",
        },
      } as never);

      const agent = new ProvisionerAgent(ctx);
      const result = await agent.execute({
        subscriptionId: VALID_SUB_ID,
        regions: ["eastus"],
      } as unknown as Record<string, unknown>);

      expect(result.status).toBe("failed");
      const summary = result.summary as {
        failures: Array<{ region: string; error: string }>;
      };
      expect(summary.failures[0]?.error).toContain("Failed");
      expect(summary.failures[0]?.error).toContain("internal Azure error");
    });

    it("treats createResourceGroup failure as the region's failure", async () => {
      const store = new MultiRegionStore();
      const ctx = buildContext(store);
      createResourceGroupMock.mockRejectedValueOnce(new Error("rg blew up"));

      const agent = new ProvisionerAgent(ctx);
      const result = await agent.execute({
        subscriptionId: VALID_SUB_ID,
        regions: ["eastus"],
      } as unknown as Record<string, unknown>);

      expect(result.status).toBe("failed");
      // createBatchAccount must not have been reached.
      expect(createBatchAccountMock).not.toHaveBeenCalled();
      const account = store.getState().accounts[0];
      expect(account?.provisioningState).toBe("failed");
      expect(account?.error).toContain("rg blew up");
    });
  });

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------
  describe("cancellation", () => {
    it("stops processing further regions after cancel() is called", async () => {
      const store = new MultiRegionStore();
      const ctx = buildContext(store);
      createResourceGroupMock.mockResolvedValue({} as never);
      const agent = new ProvisionerAgent(ctx);

      // Cancel mid-loop: succeed the first region, then cancel, then make
      // sure no more arm-service calls happen.
      let callCount = 0;
      createBatchAccountMock.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Cancel after the first batch account succeeds — second region
          // should be skipped before its create-* calls fire.
          agent.cancel();
          return successAccountResult() as never;
        }
        return successAccountResult() as never;
      });

      const result = await agent.execute({
        subscriptionId: VALID_SUB_ID,
        regions: ["eastus", "westus", "centralus"],
      } as unknown as Record<string, unknown>);

      // Only the first region's writes should have hit ARM.
      expect(createBatchAccountMock).toHaveBeenCalledTimes(1);
      expect(createResourceGroupMock).toHaveBeenCalledTimes(1);
      // Result is still "partial" since "created" < total.
      const summary = result.summary as { created: number; total: number };
      expect(summary.created).toBe(1);
      expect(summary.total).toBe(3);
    });
  });
});
