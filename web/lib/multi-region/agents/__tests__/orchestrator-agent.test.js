/**
 * Tests for OrchestratorAgent — focused on dispatch, status reporting,
 * cancellation propagation, and error handling. The sub-agent classes are
 * mocked via jest.mock so we can assert which one received the call.
 */
import { __awaiter } from "tslib";
// --- Mocks for sub-agents ----------------------------------------------------
// Each constructor returns a small stub that records the agent name and
// exposes `execute` and `cancel` jest.fn()s. The constructor itself is also
// captured so tests can introspect what the orchestrator wired up.
const provisionerStub = {
    name: "provisioner",
    execute: jest.fn(),
    cancel: jest.fn(),
};
const filterStub = {
    name: "filter",
    execute: jest.fn(),
    cancel: jest.fn(),
};
const poolStub = {
    name: "pool",
    execute: jest.fn(),
    cancel: jest.fn(),
};
const nodeStub = {
    name: "node",
    execute: jest.fn(),
    cancel: jest.fn(),
};
const workflowStub = {
    execute: jest.fn(),
    cancel: jest.fn(),
};
const ProvisionerAgentMock = jest.fn().mockImplementation(() => provisionerStub);
const FilterAgentMock = jest.fn().mockImplementation(() => filterStub);
const PoolAgentMock = jest.fn().mockImplementation(() => poolStub);
const NodeAgentMock = jest.fn().mockImplementation(() => nodeStub);
const WorkflowAgentMock = jest.fn().mockImplementation(() => workflowStub);
jest.mock("../provisioner-agent", () => ({
    ProvisionerAgent: ProvisionerAgentMock,
}));
jest.mock("../filter-agent", () => ({
    FilterAgent: FilterAgentMock,
}));
jest.mock("../pool-agent", () => ({
    PoolAgent: PoolAgentMock,
}));
jest.mock("../node-agent", () => ({
    NodeAgent: NodeAgentMock,
}));
jest.mock("../workflow-agent", () => ({
    WorkflowAgent: WorkflowAgentMock,
}));
// --- Mocks for service / auth modules ---------------------------------------
// The orchestrator's constructor fires off a discover_accounts call; we
// neutralize all the network-touching helpers to keep tests hermetic.
jest.mock("../../services", () => ({
    listSubscriptions: jest.fn().mockResolvedValue([]),
    listBatchAccounts: jest.fn().mockResolvedValue([]),
    getBatchAccount: jest.fn().mockResolvedValue(null),
    listPools: jest.fn().mockResolvedValue([]),
    createPool: jest.fn().mockResolvedValue(undefined),
    patchPool: jest.fn().mockResolvedValue(undefined),
    removeNodes: jest.fn().mockResolvedValue(undefined),
    deletePool: jest.fn().mockResolvedValue(undefined),
    listNodes: jest.fn().mockResolvedValue([]),
    performNodeAction: jest.fn().mockResolvedValue(undefined),
    listOrgUsers: jest.fn().mockResolvedValue([]),
    getMyDirectoryRoles: jest.fn().mockResolvedValue([]),
    resetUserPassword: jest.fn().mockResolvedValue(undefined),
    canResetPasswords: jest.fn().mockResolvedValue(false),
}));
jest.mock("../../auth/msal-auth", () => ({
    getGraphToken: jest.fn().mockResolvedValue("graph-token"),
    getGraphTokenForAccount: jest.fn().mockResolvedValue("graph-token"),
    listAccessibleTenants: jest.fn().mockResolvedValue([]),
    setActiveTenant: jest.fn(),
    getArmTokenForAccount: jest.fn().mockResolvedValue("arm-token"),
}));
// credential-vault touches the WebCrypto API on module load via
// `new TextEncoder()`. The orchestrator imports it for the password-
// reset path, which agent-layer tests don't exercise — stub the whole
// module to keep these tests hermetic.
jest.mock("../../auth/credential-vault", () => ({
    credentialVault: {
        put: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
        clearAll: jest.fn().mockResolvedValue(undefined),
        list: jest.fn().mockResolvedValue([]),
        get: jest.fn().mockResolvedValue(null),
    },
}));
jest.mock("../../services/audit-log", () => ({
    auditLog: { record: jest.fn() },
}));
jest.mock("../../scheduling/request-governance", () => ({
    getSharedRequestGuard: jest.fn().mockReturnValue({
        setTelemetry: jest.fn(),
    }),
}));
// --- Test imports (after mocks) ---------------------------------------------
import { OrchestratorAgent } from "../orchestrator-agent";
import { MultiRegionStore } from "../../store/multi-region-store";
// Helper: build a minimal AgentContext backed by a real store.
function makeContext() {
    const store = new MultiRegionStore();
    const scheduler = {
        run: jest.fn((_key, fn) => fn()),
    };
    return {
        store,
        scheduler,
        armUrl: "https://management.azure.com",
        getAccessToken: jest.fn().mockResolvedValue("arm-token"),
        getBatchAccessToken: jest.fn().mockResolvedValue("batch-token"),
        getGraphAccessToken: jest.fn().mockResolvedValue("graph-token"),
    };
}
const okResult = (summary = {}) => ({
    status: "completed",
    summary,
});
// Reset mock implementations between tests — clearMocks in jest.config wipes
// call history but not implementations.
beforeEach(() => {
    provisionerStub.execute.mockReset().mockResolvedValue(okResult());
    filterStub.execute
        .mockReset()
        .mockResolvedValue(okResult({ accounts: [], matchCount: 0 }));
    poolStub.execute.mockReset().mockResolvedValue(okResult());
    nodeStub.execute.mockReset().mockResolvedValue(okResult());
    workflowStub.execute.mockReset().mockResolvedValue(okResult());
    provisionerStub.cancel.mockReset();
    filterStub.cancel.mockReset();
    poolStub.cancel.mockReset();
    nodeStub.cancel.mockReset();
    workflowStub.cancel.mockReset();
    ProvisionerAgentMock.mockClear();
    FilterAgentMock.mockClear();
    PoolAgentMock.mockClear();
    NodeAgentMock.mockClear();
    WorkflowAgentMock.mockClear();
});
describe("OrchestratorAgent", () => {
    describe("construction", () => {
        it("wires up all sub-agents from the AgentContext", () => {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            expect(orch.name).toBe("orchestrator");
            expect(ProvisionerAgentMock).toHaveBeenCalledWith(ctx);
            // FilterAgent only takes the store
            expect(FilterAgentMock).toHaveBeenCalledWith(ctx.store);
            expect(PoolAgentMock).toHaveBeenCalledWith(ctx);
            expect(NodeAgentMock).toHaveBeenCalledWith(ctx);
        });
    });
    describe("execute() dispatch", () => {
        it("dispatches create_accounts to the provisioner", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            provisionerStub.execute.mockResolvedValueOnce(okResult({ created: 2 }));
            const payload = { subscriptionId: "sub", regions: ["eastus"] };
            const result = yield orch.execute({
                action: "create_accounts",
                payload,
            });
            // Provisioner now receives signal (audit fix #1) + the original
            // payload merged in.
            expect(provisionerStub.execute).toHaveBeenCalledWith(expect.objectContaining(payload));
            expect(result.status).toBe("completed");
        }));
        it("dispatches filter_accounts to the filter agent", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            const payload = { filters: { regions: ["westus"] } };
            yield orch.execute({ action: "filter_accounts", payload });
            // filter_accounts goes through filter; auto-discover may also call filter? no.
            expect(filterStub.execute).toHaveBeenCalledWith(payload);
        }));
        it("dispatches list_nodes to the node agent", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            const payload = { accountIds: ["a1"] };
            yield orch.execute({ action: "list_nodes", payload });
            // Orchestrator now spreads payload + appends a signal (audit fix #1).
            expect(nodeStub.execute).toHaveBeenCalledWith(expect.objectContaining({ accountIds: ["a1"] }));
            const callArg = nodeStub.execute.mock.calls[0][0];
            expect(callArg.signal).toBeInstanceOf(AbortSignal);
        }));
        it("dispatches node_action to the node agent", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            const payload = { actionType: "reboot", nodeIds: ["n1"] };
            yield orch.execute({ action: "node_action", payload });
            expect(nodeStub.execute).toHaveBeenCalledWith(expect.objectContaining({ actionType: "reboot", nodeIds: ["n1"] }));
            const callArg = nodeStub.execute.mock.calls[0][0];
            expect(callArg.signal).toBeInstanceOf(AbortSignal);
        }));
        it("dispatches create_pools through filter then pool agent", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            filterStub.execute.mockResolvedValue(okResult({
                accounts: [{ accountId: "a1" }, { accountId: "a2" }],
                matchCount: 2,
            }));
            const orch = new OrchestratorAgent(ctx);
            const payload = { filters: {}, poolConfig: { vmSize: "Standard_D2s_v3" } };
            yield orch.execute({ action: "create_pools", payload });
            // filter ran to resolve accountIds, then pool was invoked
            expect(filterStub.execute).toHaveBeenCalled();
            expect(poolStub.execute).toHaveBeenCalled();
        }));
        it("creates and dispatches to the workflow agent for run_workflow", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            const cfg = {
                subscriptionId: "sub",
                quotaType: "LowPriority",
                quotaLimit: 100,
                contactEmail: "x@y.com",
                poolConfig: {},
            };
            yield orch.execute({ action: "run_workflow", payload: cfg });
            // Constructed lazily inside execute(). Audit fix #3 — the
            // parent orchestrator is now passed as the 2nd arg so the
            // workflow agent re-uses the same instance instead of building
            // its own (which would double the auto-discover side effect).
            expect(WorkflowAgentMock).toHaveBeenCalledWith(ctx, orch);
            expect(workflowStub.execute).toHaveBeenCalledWith(cfg);
        }));
        it("returns failed for an unknown action", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            const result = yield orch.execute({
                action: "this_is_not_a_real_action",
                payload: {},
            });
            expect(result.status).toBe("failed");
            expect(result.summary.error).toMatch(/Unknown action/);
        }));
    });
    describe("status reporting", () => {
        it("transitions orchestrator status idle -> running -> completed on success", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            // Initial state should be idle.
            expect(ctx.store.getState().agentStatuses.orchestrator).toBe("idle");
            const orch = new OrchestratorAgent(ctx);
            // Capture state mid-flight by hooking the sub-agent's execute.
            let midflightStatus;
            filterStub.execute.mockImplementationOnce(() => __awaiter(void 0, void 0, void 0, function* () {
                midflightStatus = ctx.store.getState().agentStatuses.orchestrator;
                return okResult({ accounts: [], matchCount: 0 });
            }));
            yield orch.execute({
                action: "filter_accounts",
                payload: { filters: {} },
            });
            expect(midflightStatus).toBe("running");
            expect(ctx.store.getState().agentStatuses.orchestrator).toBe("completed");
        }));
        it("sets orchestrator status to error when the action throws", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            filterStub.execute.mockRejectedValueOnce(new Error("boom"));
            const result = yield orch.execute({
                action: "filter_accounts",
                payload: { filters: {} },
            });
            expect(result.status).toBe("failed");
            expect(result.summary.error).toMatch(/boom/);
            expect(ctx.store.getState().agentStatuses.orchestrator).toBe("error");
        }));
        it("appends a log entry on dispatch and on error", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            filterStub.execute.mockRejectedValueOnce(new Error("kaboom"));
            const before = ctx.store.getState().agentLogs.length;
            yield orch.execute({
                action: "filter_accounts",
                payload: { filters: {} },
            });
            const after = ctx.store.getState().agentLogs;
            expect(after.length).toBeGreaterThan(before);
            // One of the logs records the error.
            expect(after.some((l) => l.level === "error" && l.message.includes("kaboom"))).toBe(true);
        }));
        it("records a running activity that ends as failed on error", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            filterStub.execute.mockRejectedValueOnce(new Error("nope"));
            yield orch.execute({
                action: "filter_accounts",
                payload: { filters: {} },
            });
            const activities = ctx.store.getState().activities;
            const filterActivity = activities.find((a) => a.action === "filter_accounts");
            expect(filterActivity).toBeDefined();
            expect(filterActivity === null || filterActivity === void 0 ? void 0 : filterActivity.status).toBe("failed");
            expect(filterActivity === null || filterActivity === void 0 ? void 0 : filterActivity.error).toMatch(/nope/);
        }));
    });
    describe("cancellation", () => {
        it("propagates cancel() to all sub-agents", () => {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            orch.cancel();
            expect(provisionerStub.cancel).toHaveBeenCalled();
            expect(poolStub.cancel).toHaveBeenCalled();
            expect(nodeStub.cancel).toHaveBeenCalled();
            // filter has no cancel state but cancel() is wired only for some; that's
            // fine — the orchestrator only forwards to the agents above.
            // MonitorAgent was removed (audit fix #9) so it's no longer in the list.
        });
        it("propagates cancel to the workflow agent if one is active", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            // Hold the workflow execute open so the orchestrator instance is set.
            let releaseWorkflow;
            workflowStub.execute.mockImplementationOnce(() => new Promise((resolve) => {
                releaseWorkflow = resolve;
            }));
            const exec = orch.execute({
                action: "run_workflow",
                payload: { subscriptionId: "sub" },
            });
            // Wait a tick so WorkflowAgent is constructed.
            yield Promise.resolve();
            orch.cancel();
            expect(workflowStub.cancel).toHaveBeenCalled();
            // Resolve the workflow so the dangling promise settles.
            releaseWorkflow(okResult());
            yield exec;
        }));
        it("marks an in-flight activity as cancelling when cancel(activityId) is called", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            // Add an activity manually (mirrors what execute would set up).
            const activityId = ctx.store.addActivity({
                action: "list_nodes",
                target: "test",
                status: "running",
            });
            orch.cancel(activityId);
            const activity = ctx.store
                .getState()
                .activities.find((a) => a.id === activityId);
            expect(activity === null || activity === void 0 ? void 0 : activity.status).toBe("cancelling");
        }));
    });
    describe("error handling", () => {
        it("returns a failed result when a sub-agent throws", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            provisionerStub.execute.mockRejectedValueOnce(new Error("provision err"));
            const result = yield orch.execute({
                action: "create_accounts",
                payload: { subscriptionId: "sub", regions: ["eastus"] },
            });
            expect(result.status).toBe("failed");
            expect(result.summary.error).toMatch(/provision err/);
        }));
        it("logs the error to agentLogs", () => __awaiter(void 0, void 0, void 0, function* () {
            const ctx = makeContext();
            const orch = new OrchestratorAgent(ctx);
            poolStub.execute.mockRejectedValueOnce(new Error("pool boom"));
            filterStub.execute.mockResolvedValue(okResult({
                accounts: [{ accountId: "a1" }],
                matchCount: 1,
            }));
            yield orch.execute({
                action: "create_pools",
                payload: { filters: {}, poolConfig: {} },
            });
            const errLogs = ctx.store
                .getState()
                .agentLogs.filter((l) => l.level === "error");
            expect(errLogs.length).toBeGreaterThan(0);
        }));
    });
});
//# sourceMappingURL=orchestrator-agent.test.js.map