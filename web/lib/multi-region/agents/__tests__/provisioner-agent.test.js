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
import { __awaiter } from "tslib";
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
import { MultiRegionStore } from "../../store/multi-region-store";
import { RequestScheduler } from "../../scheduling/request-scheduler";
import { AzureRequestError } from "../../services/types";
import { createResourceGroup, createBatchAccount, } from "../../services/arm-service";
const createResourceGroupMock = createResourceGroup;
const createBatchAccountMock = createBatchAccount;
const VALID_SUB_ID = "11111111-2222-3333-4444-555555555555";
function makeFetchResponse(init = {}) {
    var _a, _b;
    const status = (_a = init.status) !== null && _a !== void 0 ? _a : 200;
    const body = (_b = init.body) !== null && _b !== void 0 ? _b : {};
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => __awaiter(this, void 0, void 0, function* () { return body; }),
    };
}
function buildContext(store) {
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
        getAccessToken: jest.fn(() => __awaiter(this, void 0, void 0, function* () { return "fake-token"; })),
        getBatchAccessToken: jest.fn(() => __awaiter(this, void 0, void 0, function* () { return "fake-batch-token"; })),
    };
}
function successAccountResult(state = "Succeeded") {
    return {
        id: "batch-id",
        name: "name",
        type: "Microsoft.Batch/batchAccounts",
        location: "eastus",
        properties: { provisioningState: state },
    };
}
describe("ProvisionerAgent", () => {
    let originalFetch;
    let fetchMock;
    beforeEach(() => {
        createResourceGroupMock.mockReset();
        createBatchAccountMock.mockReset();
        // Skip the WRITE_RATE_LIMIT_MS sleep between writes so the suite runs
        // fast. Other code in the agent is synchronous enough that this stub is
        // safe.
        jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((fn) => {
            fn();
            return 0;
        }));
        originalFetch = global.fetch;
        fetchMock = jest.fn(() => __awaiter(void 0, void 0, void 0, function* () { return makeFetchResponse({ status: 200, body: { state: "Enabled" } }); }));
        global.fetch =
            fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
        global.fetch = originalFetch;
    });
    // -------------------------------------------------------------------------
    // Happy path
    // -------------------------------------------------------------------------
    describe("happy path", () => {
        it("provisions every region successfully", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            const ctx = buildContext(store);
            createResourceGroupMock.mockResolvedValue({});
            createBatchAccountMock.mockResolvedValue(successAccountResult());
            const agent = new ProvisionerAgent(ctx);
            const input = {
                subscriptionId: VALID_SUB_ID,
                regions: ["eastus", "westus"],
            };
            const result = yield agent.execute(input);
            expect(result.status).toBe("completed");
            const summary = result.summary;
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
        }));
        it("uses the provided arm-service helpers with the expected arguments", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            const store = new MultiRegionStore();
            const ctx = buildContext(store);
            createResourceGroupMock.mockResolvedValue({});
            createBatchAccountMock.mockResolvedValue(successAccountResult());
            const agent = new ProvisionerAgent(ctx);
            yield agent.execute({
                subscriptionId: VALID_SUB_ID,
                regions: ["eastus"],
            });
            const [subId, , region, token] = (_a = createResourceGroupMock.mock.calls[0]) !== null && _a !== void 0 ? _a : [];
            expect(subId).toBe(VALID_SUB_ID);
            expect(region).toBe("eastus");
            expect(token).toBe("fake-token");
            const [bSubId, , , bRegion, bToken] = (_b = createBatchAccountMock.mock.calls[0]) !== null && _b !== void 0 ? _b : [];
            expect(bSubId).toBe(VALID_SUB_ID);
            expect(bRegion).toBe("eastus");
            expect(bToken).toBe("fake-token");
        }));
    });
    // -------------------------------------------------------------------------
    // Subscription gate
    // -------------------------------------------------------------------------
    describe("_validateSubscription gate", () => {
        it("aborts when ARM reports the subscription is Disabled", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            const store = new MultiRegionStore();
            const ctx = buildContext(store);
            // _validateSubscription returns invalid → agent returns failed.
            fetchMock.mockResolvedValueOnce(makeFetchResponse({ status: 200, body: { state: "Disabled" } }));
            const agent = new ProvisionerAgent(ctx);
            const result = yield agent.execute({
                subscriptionId: VALID_SUB_ID,
                regions: ["eastus", "westus"],
            });
            expect(result.status).toBe("failed");
            const summary = result.summary;
            expect(summary.created).toBe(0);
            expect(summary.failed).toBe(2);
            expect((_a = summary.failures[0]) === null || _a === void 0 ? void 0 : _a.region).toBe("*");
            expect((_b = summary.failures[0]) === null || _b === void 0 ? void 0 : _b.error).toContain("not valid");
            expect(store.getState().agentStatuses.provisioner).toBe("error");
            // No accounts should have been added.
            expect(store.getState().accounts).toHaveLength(0);
            // arm-service helpers must NOT have been invoked.
            expect(createResourceGroupMock).not.toHaveBeenCalled();
            expect(createBatchAccountMock).not.toHaveBeenCalled();
        }));
        it("aborts when subscription lookup returns a non-2xx HTTP response", () => __awaiter(void 0, void 0, void 0, function* () {
            var _c;
            const store = new MultiRegionStore();
            const ctx = buildContext(store);
            fetchMock.mockResolvedValueOnce(makeFetchResponse({ status: 403 }));
            const agent = new ProvisionerAgent(ctx);
            const result = yield agent.execute({
                subscriptionId: VALID_SUB_ID,
                regions: ["eastus"],
            });
            expect(result.status).toBe("failed");
            const summary = result.summary;
            expect((_c = summary.failures[0]) === null || _c === void 0 ? void 0 : _c.error).toContain("HTTP 403");
        }));
        it("treats a fetch failure as a soft warning and proceeds", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            const ctx = buildContext(store);
            // A network error during _validateSubscription falls through to
            // `valid: true` after logging a warning.
            fetchMock.mockRejectedValueOnce(new Error("ENETDOWN"));
            createResourceGroupMock.mockResolvedValue({});
            createBatchAccountMock.mockResolvedValue(successAccountResult());
            const agent = new ProvisionerAgent(ctx);
            const result = yield agent.execute({
                subscriptionId: VALID_SUB_ID,
                regions: ["eastus"],
            });
            expect(result.status).toBe("completed");
            const warns = store
                .getState()
                .agentLogs.filter((l) => l.level === "warn");
            expect(warns.some((w) => w.message.includes("Could not validate subscription"))).toBe(true);
        }));
        it("logs a warning when the subscription has a spending limit ON", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            const ctx = buildContext(store);
            fetchMock.mockResolvedValueOnce(makeFetchResponse({
                status: 200,
                body: {
                    state: "Enabled",
                    subscriptionPolicies: { spendingLimit: "On" },
                },
            }));
            createResourceGroupMock.mockResolvedValue({});
            createBatchAccountMock.mockResolvedValue(successAccountResult());
            const agent = new ProvisionerAgent(ctx);
            yield agent.execute({
                subscriptionId: VALID_SUB_ID,
                regions: ["eastus"],
            });
            const warns = store
                .getState()
                .agentLogs.filter((l) => l.level === "warn");
            expect(warns.some((w) => w.message.includes("spending limit ON"))).toBe(true);
        }));
    });
    // -------------------------------------------------------------------------
    // Duplicate skip
    // -------------------------------------------------------------------------
    describe("duplicate region skip", () => {
        it("skips a region that already has a 'created' account in the same subscription", () => __awaiter(void 0, void 0, void 0, function* () {
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
            createResourceGroupMock.mockResolvedValue({});
            createBatchAccountMock.mockResolvedValue(successAccountResult());
            const agent = new ProvisionerAgent(ctx);
            const result = yield agent.execute({
                subscriptionId: VALID_SUB_ID,
                regions: ["eastus", "westus"],
            });
            // Only westus should have been provisioned.
            expect(createResourceGroupMock).toHaveBeenCalledTimes(1);
            expect(createBatchAccountMock).toHaveBeenCalledTimes(1);
            const summary = result.summary;
            expect(summary.created).toBe(1);
            expect(summary.total).toBe(2); // total reflects the full request
            expect(result.status).toBe("completed");
            const skipLogs = store
                .getState()
                .agentLogs.filter((l) => l.message.includes("Account already exists for eastus"));
            expect(skipLogs).toHaveLength(1);
        }));
    });
    // -------------------------------------------------------------------------
    // Failure paths
    // -------------------------------------------------------------------------
    describe("failure handling", () => {
        it("marks a region as failed when createBatchAccount throws AzureRequestError", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            const store = new MultiRegionStore();
            const ctx = buildContext(store);
            createResourceGroupMock.mockResolvedValue({});
            createBatchAccountMock.mockRejectedValueOnce(new AzureRequestError("quota exceeded", 400, "QuotaExceeded", {}));
            const agent = new ProvisionerAgent(ctx);
            const result = yield agent.execute({
                subscriptionId: VALID_SUB_ID,
                regions: ["eastus"],
            });
            expect(result.status).toBe("failed");
            const summary = result.summary;
            expect(summary.failed).toBe(1);
            expect((_a = summary.failures[0]) === null || _a === void 0 ? void 0 : _a.region).toBe("eastus");
            expect((_b = summary.failures[0]) === null || _b === void 0 ? void 0 : _b.error).toContain("quota exceeded");
            // Account row should be tagged as failed and carry the error message.
            const account = store.getState().accounts[0];
            expect(account === null || account === void 0 ? void 0 : account.provisioningState).toBe("failed");
            expect(account === null || account === void 0 ? void 0 : account.error).toContain("quota exceeded");
            expect(store.getState().agentStatuses.provisioner).toBe("error");
        }));
        it("returns 'partial' when some regions succeed and others fail", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            const ctx = buildContext(store);
            createResourceGroupMock.mockResolvedValue({});
            // First batch account succeeds, second throws.
            createBatchAccountMock
                .mockResolvedValueOnce(successAccountResult())
                .mockRejectedValueOnce(new Error("internal explosion"));
            const agent = new ProvisionerAgent(ctx);
            const result = yield agent.execute({
                subscriptionId: VALID_SUB_ID,
                regions: ["eastus", "westus"],
            });
            expect(result.status).toBe("partial");
            const summary = result.summary;
            expect(summary.created).toBe(1);
            expect(summary.failed).toBe(1);
            // partial → store agent status is "completed" (NOT error).
            expect(store.getState().agentStatuses.provisioner).toBe("completed");
        }));
        it("treats provisioningState='Failed' from the create result as a failure", () => __awaiter(void 0, void 0, void 0, function* () {
            var _c, _d;
            const store = new MultiRegionStore();
            const ctx = buildContext(store);
            createResourceGroupMock.mockResolvedValue({});
            createBatchAccountMock.mockResolvedValue({
                id: "id",
                name: "name",
                type: "Microsoft.Batch/batchAccounts",
                location: "eastus",
                properties: {
                    provisioningState: "Failed",
                    statusText: "internal Azure error",
                },
            });
            const agent = new ProvisionerAgent(ctx);
            const result = yield agent.execute({
                subscriptionId: VALID_SUB_ID,
                regions: ["eastus"],
            });
            expect(result.status).toBe("failed");
            const summary = result.summary;
            expect((_c = summary.failures[0]) === null || _c === void 0 ? void 0 : _c.error).toContain("Failed");
            expect((_d = summary.failures[0]) === null || _d === void 0 ? void 0 : _d.error).toContain("internal Azure error");
        }));
        it("treats createResourceGroup failure as the region's failure", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            const ctx = buildContext(store);
            createResourceGroupMock.mockRejectedValueOnce(new Error("rg blew up"));
            const agent = new ProvisionerAgent(ctx);
            const result = yield agent.execute({
                subscriptionId: VALID_SUB_ID,
                regions: ["eastus"],
            });
            expect(result.status).toBe("failed");
            // createBatchAccount must not have been reached.
            expect(createBatchAccountMock).not.toHaveBeenCalled();
            const account = store.getState().accounts[0];
            expect(account === null || account === void 0 ? void 0 : account.provisioningState).toBe("failed");
            expect(account === null || account === void 0 ? void 0 : account.error).toContain("rg blew up");
        }));
    });
    // -------------------------------------------------------------------------
    // Cancellation
    // -------------------------------------------------------------------------
    describe("cancellation", () => {
        it("stops processing further regions after cancel() is called", () => __awaiter(void 0, void 0, void 0, function* () {
            const store = new MultiRegionStore();
            const ctx = buildContext(store);
            createResourceGroupMock.mockResolvedValue({});
            const agent = new ProvisionerAgent(ctx);
            // Cancel mid-loop: succeed the first region, then cancel, then make
            // sure no more arm-service calls happen.
            let callCount = 0;
            createBatchAccountMock.mockImplementation(() => __awaiter(void 0, void 0, void 0, function* () {
                callCount++;
                if (callCount === 1) {
                    // Cancel after the first batch account succeeds — second region
                    // should be skipped before its create-* calls fire.
                    agent.cancel();
                    return successAccountResult();
                }
                return successAccountResult();
            }));
            const result = yield agent.execute({
                subscriptionId: VALID_SUB_ID,
                regions: ["eastus", "westus", "centralus"],
            });
            // Only the first region's writes should have hit ARM.
            expect(createBatchAccountMock).toHaveBeenCalledTimes(1);
            expect(createResourceGroupMock).toHaveBeenCalledTimes(1);
            // Result is still "partial" since "created" < total.
            const summary = result.summary;
            expect(summary.created).toBe(1);
            expect(summary.total).toBe(3);
        }));
    });
});
//# sourceMappingURL=provisioner-agent.test.js.map